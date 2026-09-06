"""
The training pipeline: dataset integrity, the fit, and what the runtime sees.

Nothing here reaches the network. The dataset under test is the committed one
the fetch script produced; its provenance is part of what these tests verify.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import math
import subprocess
import sys
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.data.rainfall import (
    MAX_DATASET_AGE_YEARS,
    RainfallDatasetError,
    dataset_age_years,
    date_at,
    day_index,
    expected_day_count,
    load_rainfall_dataset,
)
from app.data.regions import Region, RegionRegistryError, load_region_registry
from app.main import create_app
from app.models.artifact import ModelArtifactError, compute_checksum, load_artifact
from tests.conftest_helpers import ARTIFACT_PATH, MODULE_ROOT

DATASET_PATH = MODULE_ROOT / "data/rainfall-history.json"
REGIONS_PATH = MODULE_ROOT / "data/regions.json"
METRICS_PATH = MODULE_ROOT / "app/models/artifacts/baseline-premium-v3.metrics.json"
PREVIOUS_PATH = MODULE_ROOT / "app/models/artifacts/archive/baseline-premium-v1.json"


def _load_script(name: str):
    """Imports a script under scripts/ as a module without running it."""
    path = MODULE_ROOT / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def dataset():
    return load_rainfall_dataset(DATASET_PATH)


@pytest.fixture(scope="module")
def trainer():
    return _load_script("train_rainfall_model")


@pytest.fixture(scope="module")
def fetcher():
    return _load_script("fetch_rainfall_history")


class TestDataset:
    def test_loads_and_verifies_the_committed_history(self, dataset) -> None:
        # The dataset names its own range, and the range is the rolling
        # thirty-year window the fetcher is defined by.
        assert dataset.dataset_version == (
            f"rainfall-history-{dataset.start.year}-{dataset.end.year}"
        )
        assert dataset.start == date(dataset.end.year - 29, 1, 1)
        assert (dataset.end.month, dataset.end.day) == (12, 31)

    def test_is_fresh_enough_to_price_from(self, dataset) -> None:
        # The freshness policy, as a test: this fails on purpose once the
        # dataset is more than MAX_DATASET_AGE_YEARS complete years behind the
        # most recent one, so a refresh is a planned act rather than a slow
        # drift nobody noticed. Refresh with scripts/fetch_rainfall_history.py.
        assert dataset_age_years(dataset, date.today()) <= MAX_DATASET_AGE_YEARS
        assert dataset.days == expected_day_count(dataset.start, dataset.end)
        assert len(dataset.regions) == 8
        for series in dataset.regions.values():
            assert len(series.mm_per_day) == dataset.days
            assert all(v >= 0 and math.isfinite(v) for v in series.mm_per_day)

    def test_covers_exactly_the_registered_regions(self, dataset) -> None:
        # The registry is the input the fetch reads; the dataset is its output.
        # A region in one and not the other means one of them was edited without
        # the other being regenerated.
        registry = json.loads(REGIONS_PATH.read_text(encoding="utf-8"))["regions"]
        assert set(registry) == set(dataset.regions)
        for key, entry in registry.items():
            assert dataset.regions[key].latitude == entry["latitude"]
            assert dataset.regions[key].longitude == entry["longitude"]

    def test_records_where_the_data_came_from(self, dataset) -> None:
        # Provenance is a stage deliverable, not a nicety: a number with no
        # source cannot be audited.
        assert "Open-Meteo" in dataset.source["provider"]
        assert dataset.source["units"] == "mm"
        assert dataset.source["url"].startswith("https://")

    def test_looks_like_real_climate(self, dataset) -> None:
        # Sanity, not science: Lima is one of the driest cities on earth and
        # Medellín one of the wettest regions in the set. A dataset in which
        # that ordering did not hold would be mislabeled or corrupted.
        mean = {
            k: sum(s.mm_per_day) / len(s.mm_per_day) for k, s in dataset.regions.items()
        }
        assert mean["lima"] < 0.5
        assert mean["medellin"] > 5.0
        assert mean["lima"] < mean["valencia"] < mean["medellin"]

    def test_date_indexing_round_trips(self, dataset) -> None:
        assert day_index(dataset, dataset.start) == 0
        assert day_index(dataset, dataset.end) == dataset.days - 1
        assert date_at(dataset, day_index(dataset, date(2019, 1, 1))) == date(
            2019, 1, 1
        )

    @pytest.mark.parametrize(
        ("mutate", "expected"),
        [
            (
                lambda p: p["regions"]["lima"]["mmPerDay"].__setitem__(0, -1.0),
                "not a valid precipitation",
            ),
            (lambda p: p["regions"]["lima"]["mmPerDay"].pop(), "values for"),
            (
                lambda p: p["regions"]["lima"]["mmPerDay"].__setitem__(0, "0.5"),
                "is not a number",
            ),
            (lambda p: p.__setitem__("days", 5), "spans"),
            (lambda p: p.__setitem__("schemaVersion", 2), "schemaVersion"),
            (lambda p: p.__setitem__("regions", {}), "at least one region"),
            # A finite number can still be impossible: above the WMO record.
            (
                lambda p: p["regions"]["lima"]["mmPerDay"].__setitem__(0, 1_000_000.0),
                "physically plausible",
            ),
            # Valid JSON, no float to become. Used to escape as OverflowError.
            (
                lambda p: p["regions"]["lima"]["mmPerDay"].__setitem__(0, 10**400),
                "too large",
            ),
            # Provenance is part of the data; `[]` used to read as `{}`.
            (lambda p: p.__setitem__("source", []), "source"),
            (lambda p: p["source"].pop("url"), "source.url"),
            (lambda p: p["source"].__setitem__("licence", ""), "source.licence"),
            (lambda p: p["regions"]["lima"].__setitem__("latitude", True), "latitude"),
            (lambda p: p["regions"]["lima"].__setitem__("longitude", 200), "longitude"),
            (lambda p: p.__setitem__("datasetVersion", 7), "datasetVersion"),
        ],
    )
    def test_rejects_a_corrupted_dataset(self, tmp_path, mutate, expected: str) -> None:
        payload = json.loads(DATASET_PATH.read_text(encoding="utf-8"))
        mutate(payload)
        payload["checksum"] = compute_checksum(payload)
        path = tmp_path / "bad.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

        with pytest.raises(RainfallDatasetError, match=expected):
            load_rainfall_dataset(path)

    def test_rejects_a_tampered_value(self, tmp_path) -> None:
        # Changed after the checksum was written: the case the checksum exists for.
        payload = json.loads(DATASET_PATH.read_text(encoding="utf-8"))
        payload["regions"]["lima"]["mmPerDay"][0] += 1.0
        path = tmp_path / "tampered.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

        with pytest.raises(RainfallDatasetError, match="integrity check"):
            load_rainfall_dataset(path)


class TestRegionRegistry:
    """The registry decides where thirty years of data are read from."""

    def test_loads_the_committed_registry(self) -> None:
        registry = load_region_registry(REGIONS_PATH)
        assert set(registry) == {
            "valencia",
            "sevilla",
            "bogota",
            "medellin",
            "cartagena",
            "lima",
            "santiago",
            "buenos aires",
        }
        assert isinstance(registry["lima"], Region)
        assert registry["lima"].country == "PE"

    @pytest.mark.parametrize(
        ("mutate", "expected"),
        [
            # A key the runtime could never resolve to: lookups lowercase first.
            (
                lambda p: p["regions"].__setitem__("Lima", p["regions"].pop("lima")),
                "not canonical",
            ),
            (lambda p: p["regions"]["lima"].__setitem__("latitude", 91), "within"),
            # `true` is an int in Python; as a longitude it would be 1.0 east.
            (
                lambda p: p["regions"]["lima"].__setitem__("longitude", True),
                "must be a number",
            ),
            (lambda p: p["regions"]["lima"].__setitem__("name", ""), "non-empty"),
            (lambda p: p["regions"]["lima"].pop("country"), "non-empty"),
            (lambda p: p.__setitem__("schemaVersion", 2), "schemaVersion"),
            (lambda p: p.__setitem__("regions", {}), "at least one region"),
            (
                lambda p: p["regions"].__setitem__("x" * 32, p["regions"]["lima"]),
                "on-chain region budget",
            ),
        ],
    )
    def test_rejects_a_malformed_registry(self, tmp_path, mutate, expected) -> None:
        payload = json.loads(REGIONS_PATH.read_text(encoding="utf-8"))
        mutate(payload)
        path = tmp_path / "regions.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

        with pytest.raises(RegionRegistryError, match=expected):
            load_region_registry(path)

    def test_rejects_a_repeated_key(self, tmp_path) -> None:
        # `json.loads` keeps the last of two entries silently; the region would
        # then be fetched from whichever coordinates were written last.
        text = REGIONS_PATH.read_text(encoding="utf-8").replace(
            '"lima":', '"sevilla":', 1
        )
        path = tmp_path / "regions.json"
        path.write_text(text, encoding="utf-8")

        with pytest.raises(RegionRegistryError, match="duplicate JSON member"):
            load_region_registry(path)


class TestFetchValidation:
    """The fetch script's own checks, exercised on fabricated payloads. No network."""

    def test_the_window_rolls_with_the_calendar(self, fetcher) -> None:
        # Thirty complete years ending at the last complete one, so a refresh
        # refreshes the evidence rather than re-downloading the same decades.
        assert fetcher.window_for(date(2026, 9, 6)) == (
            date(1996, 1, 1),
            date(2025, 12, 31),
        )
        assert fetcher.window_for(date(2027, 1, 1)) == (
            date(1997, 1, 1),
            date(2026, 12, 31),
        )
        assert (
            f"rainfall-history-{fetcher.START.year}-{fetcher.END.year}"
        ) == fetcher.DATASET_VERSION

    @staticmethod
    def _region() -> Region:
        return Region(
            key="lima", name="Lima", country="PE", latitude=-12.0, longitude=-77.0
        )

    @staticmethod
    def _body(fetcher, values: list | None = None) -> dict:
        dates = fetcher.expected_dates()
        return {
            "daily_units": {"precipitation_sum": "mm"},
            "daily": {
                "time": dates,
                "precipitation_sum": (
                    values if values is not None else [0.0] * len(dates)
                ),
            },
        }

    def test_accepts_a_well_formed_response(self, fetcher) -> None:
        series = fetcher.parse_series("lima", self._body(fetcher))
        assert len(series) == expected_day_count(fetcher.START, fetcher.END)
        assert set(series) == {0.0}

    def test_rounds_to_the_precision_the_source_reports(self, fetcher) -> None:
        body = self._body(fetcher)
        body["daily"]["precipitation_sum"][0] = 1.26
        assert fetcher.parse_series("lima", body)[0] == 1.3

    @pytest.mark.parametrize(
        ("mutate", "expected"),
        [
            # Each of these used to be accepted: a boolean read as 1 mm, a
            # string coerced, and a NaN passed every `<` check and would have
            # been written into the committed dataset.
            (
                lambda b: b["daily"]["precipitation_sum"].__setitem__(0, True),
                "not a number",
            ),
            (
                lambda b: b["daily"]["precipitation_sum"].__setitem__(0, "0.5"),
                "not a number",
            ),
            (
                lambda b: b["daily"]["precipitation_sum"].__setitem__(0, float("nan")),
                "not a valid precipitation",
            ),
            (
                lambda b: b["daily"]["precipitation_sum"].__setitem__(0, float("inf")),
                "not a valid precipitation",
            ),
            (
                lambda b: b["daily"]["precipitation_sum"].__setitem__(0, -0.1),
                "not a valid precipitation",
            ),
            (
                lambda b: b["daily"]["precipitation_sum"].__setitem__(0, None),
                "missing days",
            ),
            (lambda b: b["daily"]["precipitation_sum"].pop(), "expected"),
            # The calendar is part of the contract, not an assumption.
            (lambda b: b["daily"].pop("time"), "daily.time"),
            (lambda b: b["daily"]["time"].__setitem__(0, "1994-12-31"), "daily.time"),
            (
                lambda b: b["daily_units"].__setitem__("precipitation_sum", "inch"),
                "millimetres",
            ),
            # Used to raise AttributeError instead of the contract's FetchError.
            (lambda b: b.__setitem__("daily_units", []), "millimetres"),
            (lambda b: b.pop("daily"), "no daily block"),
            # Finite, correctly united, and impossible.
            (
                lambda b: b["daily"]["precipitation_sum"].__setitem__(0, 1_000_000.0),
                "physically plausible",
            ),
        ],
    )
    def test_refuses_a_response_it_cannot_trust(
        self, fetcher, mutate, expected
    ) -> None:
        body = self._body(fetcher)
        mutate(body)

        with pytest.raises(fetcher.FetchError, match=expected):
            fetcher.parse_series("lima", body)

    def test_payload_carries_provenance_and_a_checksum(self, fetcher) -> None:
        regions = {"lima": self._region()}
        series = {"lima": [0.0] * expected_day_count(fetcher.START, fetcher.END)}
        payload = fetcher.build_payload(regions, series)

        assert payload["datasetVersion"] == fetcher.DATASET_VERSION
        assert payload["days"] == len(series["lima"])
        assert payload["regions"]["lima"]["country"] == "PE"
        assert payload["checksum"] == compute_checksum(payload)

    def test_a_refresh_that_changes_nothing_keeps_its_timestamp(
        self, tmp_path, fetcher
    ) -> None:
        # So `git status` reports a real change in the source, never a re-run.
        regions = {"lima": self._region()}
        series = {"lima": [0.1] * expected_day_count(fetcher.START, fetcher.END)}
        first = fetcher.build_payload(regions, series)
        first["fetchedAt"] = "2000-01-01T00:00:00Z"
        first["checksum"] = compute_checksum(first)
        out = tmp_path / "d.json"
        out.write_text(json.dumps(first), encoding="utf-8")

        second = fetcher._preserve_fetched_at(
            fetcher.build_payload(regions, series), out
        )

        assert second["fetchedAt"] == "2000-01-01T00:00:00Z"
        assert second["checksum"] == first["checksum"]

    def test_writes_a_dataset_the_loader_accepts(self, tmp_path, fetcher) -> None:
        regions = {"lima": self._region()}
        days = expected_day_count(fetcher.START, fetcher.END)
        out = tmp_path / "d.json"

        fetcher.write_dataset(
            fetcher.build_payload(regions, {"lima": [0.1] * days}), out
        )

        assert load_rainfall_dataset(out).regions["lima"].mm_per_day[0] == 0.1
        assert not out.with_name(out.name + ".tmp").exists()

    def test_a_dataset_that_does_not_load_never_replaces_the_old_one(
        self, tmp_path, fetcher
    ) -> None:
        # The failure this guards: a refresh that produced something the trainer
        # cannot read used to overwrite the good file first and find out second.
        regions = {"lima": self._region()}
        days = expected_day_count(fetcher.START, fetcher.END)
        out = tmp_path / "d.json"
        fetcher.write_dataset(
            fetcher.build_payload(regions, {"lima": [0.1] * days}), out
        )
        before = out.read_bytes()

        # One value short: a shape the loader refuses.
        bad = fetcher.build_payload(regions, {"lima": [0.1] * (days - 1)})
        with pytest.raises(fetcher.FetchError, match="refusing to replace"):
            fetcher.write_dataset(bad, out)

        assert out.read_bytes() == before
        assert not out.with_name(out.name + ".tmp").exists()


class TestTraining:
    def test_split_is_by_calendar_and_disjoint(self, trainer, dataset) -> None:
        # The holdout is the most recent complete years, derived from the
        # dataset, so a refreshed dataset moves the split with it.
        train, test = trainer.make_splits(dataset)
        assert train.end_index == test.start_index
        assert test.end_index == dataset.days
        train_end = date_at(dataset, train.end_index - 1)
        assert (train_end.month, train_end.day) == (12, 31)
        assert date_at(dataset, test.start_index) == date(
            dataset.end.year - trainer.HOLDOUT_YEARS + 1, 1, 1
        )

    def test_windows_do_not_overlap(self, trainer, dataset) -> None:
        train, _ = trainer.make_splits(dataset)
        series = dataset.regions["medellin"].mm_per_day
        outcomes = trainer.window_outcomes(series, train, 30, 50)
        days_in_split = train.end_index - train.start_index
        assert len(outcomes) == days_in_split // 30

    def test_region_means_are_measured_on_the_training_period_only(
        self, trainer, dataset
    ) -> None:
        # No leakage: nothing recorded about a region may see the holdout.
        train, _ = trainer.make_splits(dataset)
        means = trainer.region_means(dataset, train)
        series = dataset.regions["lima"].mm_per_day[train.start_index : train.end_index]
        assert means["lima"] == pytest.approx(sum(series) / len(series), abs=1e-6)

    def test_region_effects_are_fitted_and_anchored_at_the_driest(
        self, trainer, dataset
    ) -> None:
        # One effect per region, in log-odds, shifted so the loader's
        # non-negativity holds with the driest region at exactly zero. The
        # ordering must agree with the climate the means describe.
        train, _ = trainer.make_splits(dataset)
        coefficients, risks = trainer.fit(dataset, train)
        assert min(risks.values()) == 0.0
        assert risks["lima"] == 0.0
        assert risks["lima"] < risks["valencia"] < risks["medellin"]
        # The effect is carried verbatim: its coefficient is one.
        assert coefficients[3] == 1.0

    def test_the_fit_does_not_see_the_holdout(self, trainer, dataset) -> None:
        # Fitting on everything gives different effects than fitting on the
        # training years, which is the only way to know the split is real.
        train, test = trainer.make_splits(dataset)
        everything = trainer.Split("all", 0, test.end_index)
        _, on_train = trainer.fit(dataset, train)
        _, on_all = trainer.fit(dataset, everything)
        assert on_train != on_all

    def test_retraining_reproduces_the_committed_artifact(
        self, trainer, dataset
    ) -> None:
        # The reproducibility criterion, as a unit test rather than only a gate.
        train, _ = trainer.make_splits(dataset)
        coefficients, risks = trainer.fit(dataset, train)
        committed = load_artifact(ARTIFACT_PATH)
        assert list(committed.coefficients) == [
            round(float(v), 12) for v in coefficients
        ]
        assert committed.region_risk == risks
        # And the plain-units description travels with it.
        artifact = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        assert artifact["training"]["regionMeanMmPerDay"] == trainer.region_means(
            dataset, train
        )

    def test_coefficient_signs_are_physical(self) -> None:
        artifact = load_artifact(ARTIFACT_PATH)
        by_name = dict(zip(artifact.features, artifact.coefficients, strict=True))
        assert by_name["log_threshold_mm"] < 0  # higher threshold, rarer trigger
        assert by_name["log_duration_days"] > 0  # longer window, likelier trigger
        assert by_name["region_risk"] > 0  # wetter region, likelier trigger

    def test_holdout_metrics_are_proper_and_calibrated(self) -> None:
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        holdout = metrics["holdout"]
        assert holdout["windows"] > 10_000
        assert 0 < holdout["logLoss"] < 1
        assert 0 < holdout["brier"] < 0.25
        # Calibration in aggregate: never below what happened in six years the
        # fit never saw, and not far above it. Slightly above is by design —
        # the evidence floor only ever raises a price — and the margin is
        # bounded so conservatism cannot quietly become over-charging.
        gap = holdout["predictedTriggerRate"] - holdout["observedTriggerRate"]
        assert 0 <= gap < 0.05

    @staticmethod
    def _previous(metrics: dict, kind: str) -> dict:
        matching = [m for m in metrics["previousModels"] if m["trainingKind"] == kind]
        assert matching, kind
        return matching[-1]

    def test_beats_the_synthetic_model_on_the_same_holdout(self) -> None:
        # The falsifiable claim behind this stage: real data prices real risk
        # better than invented data did. Scored by the same evaluator, on the
        # same windows, so the comparison is between models and nothing else.
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        holdout = metrics["holdout"]
        synthetic = self._previous(metrics, "synthetic")
        assert holdout["logLoss"] < synthetic["logLoss"]
        assert holdout["brier"] < synthetic["brier"]

    def test_beats_the_last_observed_release_on_the_same_holdout(self) -> None:
        # The comparison that matters once a real model exists: a new release
        # must improve on the one it replaces, on the same windows.
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        holdout = metrics["holdout"]
        previous = self._previous(metrics, "observed")
        assert previous["modelVersion"] != metrics["modelVersion"]
        assert holdout["logLoss"] < previous["logLoss"]
        assert holdout["brier"] < previous["brier"]

    def test_the_synthetic_model_underpriced_real_risk(self) -> None:
        # Recorded because it is the reason Stage 08 exists, not merely a score:
        # the placeholder would have predicted far fewer payouts than occurred.
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        holdout = metrics["holdout"]
        synthetic = self._previous(metrics, "synthetic")
        assert synthetic["predictedTriggerRate"] < holdout["observedTriggerRate"] / 2

    def test_artifact_metrics_match_the_metrics_file(self) -> None:
        artifact = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        assert artifact["training"]["metrics"]["holdout"] == metrics["holdout"]
        assert artifact["training"]["datasetVersion"] == metrics["datasetVersion"]

    def test_config_hash_tracks_the_trainer_itself(self, trainer, dataset) -> None:
        artifact = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        assert artifact["training"]["configHash"] == trainer.config_hash(dataset)

    def test_the_trainer_fingerprint_ignores_line_endings(self, trainer) -> None:
        # A CRLF checkout has not changed the training procedure, and must not
        # change the artifact's checksum.
        lf = b"a = 1\nb = 2\n"
        crlf = b"a = 1\r\nb = 2\r\n"
        assert trainer.source_fingerprint(lf) == trainer.source_fingerprint(crlf)
        assert trainer.source_fingerprint(lf) != trainer.source_fingerprint(b"a = 2\n")

    def _check(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "scripts/train_rainfall_model.py", "--check", *args],
            cwd=MODULE_ROOT,
            capture_output=True,
            text=True,
        )

    def test_check_mode_passes_on_the_committed_files_and_writes_nothing(self) -> None:
        before = (ARTIFACT_PATH.read_bytes(), METRICS_PATH.read_bytes())

        result = self._check()

        assert result.returncode == 0, result.stdout + result.stderr
        assert (ARTIFACT_PATH.read_bytes(), METRICS_PATH.read_bytes()) == before

    def test_check_mode_fails_on_a_drifted_artifact(self, tmp_path) -> None:
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        payload["coefficients"][0] += 0.001
        payload["checksum"] = compute_checksum(payload)
        drifted = tmp_path / "drifted.json"
        drifted.write_text(json.dumps(payload), encoding="utf-8")

        result = self._check("--output", str(drifted))

        assert result.returncode != 0
        assert "differs" in result.stdout + result.stderr
        # And it did not "fix" the drift by writing.
        assert json.loads(drifted.read_text(encoding="utf-8")) == payload

    def test_check_mode_fails_when_the_artifact_is_missing(self, tmp_path) -> None:
        # The gate must never be what creates an artifact: a deleted one would
        # be regenerated instead of noticed.
        absent = tmp_path / "absent.json"

        result = self._check("--output", str(absent))

        assert result.returncode != 0
        assert "does not exist" in result.stdout + result.stderr
        assert not absent.exists()

    def test_release_publishes_both_files_or_neither(self, tmp_path, trainer) -> None:
        # A release whose artifact the runtime would refuse must leave the
        # committed pair untouched, with no staging files behind.
        good = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        out = tmp_path / "model.json"
        met = tmp_path / "model.metrics.json"
        trainer.release(good, metrics, out, met)
        assert load_artifact(out).checksum == good["checksum"]
        before = (out.read_bytes(), met.read_bytes())

        bad = dict(good)
        bad["coefficients"] = "not-a-list"
        bad["checksum"] = compute_checksum(bad)
        with pytest.raises(ModelArtifactError):
            trainer.release(bad, {"stale": False}, out, met)

        assert (out.read_bytes(), met.read_bytes()) == before
        assert not list(tmp_path.glob("*.tmp"))

    def test_metrics_are_reported_per_region(self) -> None:
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        by_region = metrics["holdout"]["byRegion"]
        assert set(by_region) == set(load_artifact(ARTIFACT_PATH).known_regions)
        assert (
            sum(r["windows"] for r in by_region.values())
            == (metrics["holdout"]["windows"])
        )
        for previous in metrics["previousModels"]:
            assert set(previous["byRegion"]) == set(by_region)

    def test_every_duration_is_solvent_including_the_long_ones(self) -> None:
        # Long windows have few holdout windows per cell, so they are judged
        # pooled across regions and thresholds, where the sample is real: for
        # every duration in the grid, charged must cover paid.
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        by_duration = metrics["holdout"]["byDuration"]
        assert set(by_duration) == {"7", "14", "30", "60", "90", "180", "365"}
        for duration, scores in by_duration.items():
            assert scores["loadedPremiumRate"] >= scores["observedTriggerRate"], (
                duration
            )

    def test_every_start_month_is_priced_at_or_above_what_happened(self) -> None:
        # Seasonality, judged where it bites: windows of a month or less,
        # grouped by the month they start in. Charged must cover paid in each.
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        by_month = metrics["holdout"]["byStartMonth"]
        assert set(by_month) == {str(m) for m in range(1, 13)}
        for month, scores in by_month.items():
            assert scores["loadedPremiumRate"] >= scores["observedTriggerRate"], month

    def test_loaded_premiums_cover_observed_payouts_in_every_region(self) -> None:
        # The risk-acceptance policy, stated where it is enforced: over the
        # six held-out years, in every region, what the pool would have
        # charged must be at least what it would have paid. Per region rather
        # than in aggregate, because an aggregate can hide one region priced
        # badly behind seven priced well. The synthetic model failed this in
        # every wet region.
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        for key, region in metrics["holdout"]["byRegion"].items():
            assert region["loadedPremiumRate"] >= region["observedTriggerRate"], key

    def test_cells_are_judged_by_what_their_sample_can_prove(self) -> None:
        # Every grid cell, including the long windows with six holdout
        # observations: a cell is under-priced with confidence when the loaded
        # premium is below the one-sided 95% lower bound of its observed
        # frequency. Six of six proves 0.607, not 1.0, and the criterion says
        # so. The acceptance policy is to stay within what chance alone would
        # flag for a calibrated model — with 448 cells at 95%, about 22, and
        # 30 as the upper bound — because zero is a promise no honest model can
        # make about six years of weather.
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        cells = metrics["holdout"]["cells"]
        assert cells["total"] == 8 * 7 * 8
        assert cells["confidence"] == 0.95
        assert 20 <= cells["chanceAllowance"] <= 35
        assert cells["underpricedWithConfidence"] <= cells["chanceAllowance"]
        assert cells["withinChanceAllowance"] is True
        listed = cells["underpricedWithConfidenceCells"]
        assert len(listed) == cells["underpricedWithConfidence"]
        for cell in listed:
            assert cell["loadedPremiumRate"] < cell["observedLowerBound"]
            assert cell["observedLowerBound"] <= cell["observedTriggerRate"]
        # The criterion has teeth: the synthetic model fails it by an order of
        # magnitude, and this release flags fewer cells than the one before.
        synthetic = self._previous(metrics, "synthetic")
        assert (
            synthetic["cells"]["underpricedWithConfidence"]
            > (synthetic["cells"]["chanceAllowance"])
        )
        previous = self._previous(metrics, "observed")
        assert (
            cells["underpricedWithConfidence"]
            < (previous["cells"]["underpricedWithConfidence"])
        )

    def test_the_confidence_bound_is_exact(self, trainer) -> None:
        # Six of six at 95%: the largest p for which six straight triggers are
        # still a 5% event is 0.05 ** (1/6).
        assert trainer.binomial_lower_bound(6, 6, 0.95) == pytest.approx(
            0.05 ** (1 / 6), abs=1e-6
        )
        assert trainer.binomial_lower_bound(0, 10, 0.95) == 0.0
        assert 0 < trainer.binomial_lower_bound(3, 12, 0.95) < 3 / 12
        assert trainer.binomial_lower_bound(500, 1000, 0.95) == pytest.approx(
            0.474, abs=0.002
        )
        # And the chance allowance: 448 trials at 5% has mean 22.4.
        assert trainer.binomial_upper_quantile(448, 0.05, 0.95) == 30

    def test_beats_the_synthetic_model_in_every_region_with_measurable_risk(
        self,
    ) -> None:
        # Where triggers actually occur on the grid, real data must price
        # better. Lima is excluded on purpose and tested next: its observed
        # rate is near zero and the model family cannot reach it.
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        holdout = metrics["holdout"]
        synthetic = self._previous(metrics, "synthetic")
        compared = 0
        for key, region in holdout["byRegion"].items():
            if region["observedTriggerRate"] < 0.01:
                continue
            assert region["logLoss"] < synthetic["byRegion"][key]["logLoss"], key
            compared += 1
        assert compared >= 7

    def test_a_failed_second_publish_restores_the_metrics(
        self, tmp_path, trainer, monkeypatch
    ) -> None:
        # The pair on disk stays a pair: if the artifact cannot be moved into
        # place after the metrics were, the metrics go back.
        good = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        out = tmp_path / "model.json"
        met = tmp_path / "model.metrics.json"
        trainer.release(good, metrics, out, met)
        before = (out.read_bytes(), met.read_bytes())

        real_replace = trainer.os.replace
        moves: list[str] = []

        def flaky_replace(source, destination):
            moves.append(str(destination))
            if len(moves) == 2:
                raise OSError("disk went away between the two renames")
            return real_replace(source, destination)

        monkeypatch.setattr(trainer.os, "replace", flaky_replace)
        newer = dict(metrics, note="newer")
        with pytest.raises(OSError):
            trainer.release(good, newer, out, met)

        assert (out.read_bytes(), met.read_bytes()) == before
        assert not list(tmp_path.glob("*.tmp"))

    def test_the_driest_region_errs_on_the_safe_side(self) -> None:
        # Lima: a known limitation, recorded in the stage report. The model
        # overstates a near-zero risk rather than understating it, which costs
        # the buyer margin and never the pool its solvency. Guarded so a change
        # that flips it to under-pricing fails here rather than in production.
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        lima = metrics["holdout"]["byRegion"]["lima"]
        assert lima["observedTriggerRate"] < 0.01
        assert lima["predictedTriggerRate"] > lima["observedTriggerRate"]


# The smallest provenance block an observed artifact may carry; the malformed
# cases below each break exactly one thing in it.
OBSERVED_PROVENANCE = {
    "kind": "observed",
    "transitional": False,
    "datasetVersion": "d",
    "datasetChecksum": "a" * 64,
    "configHash": "b" * 64,
    "source": {"provider": "x", "url": "https://example"},
    "dateRange": {"start": "1995-01-01", "end": "2024-12-31"},
}


class TestProvenanceInTheRuntime:
    def test_current_artifact_is_observed_and_not_transitional(self) -> None:
        artifact = load_artifact(ARTIFACT_PATH)
        assert artifact.training_kind == "observed"
        assert artifact.transitional is False
        assert artifact.dataset_version == (
            load_rainfall_dataset(DATASET_PATH).dataset_version
        )

    def test_archived_synthetic_artifact_still_loads_and_says_so(self) -> None:
        # Kept for the comparison, and honest about what it is.
        previous = load_artifact(PREVIOUS_PATH)
        assert previous.model_version == "baseline-premium-v1"
        assert previous.training_kind == "synthetic"
        assert previous.transitional is True

    def test_readiness_reports_provenance(self) -> None:
        settings = Settings(
            _env_file=None,
            APP_ENV="test",
            MODEL_PROVIDER="baseline",
            MODEL_PATH=str(ARTIFACT_PATH),
        )
        with TestClient(create_app(settings)) as client:
            body = client.get("/health/ready").json()["model"]
        assert (
            body["datasetVersion"]
            == load_rainfall_dataset(DATASET_PATH).dataset_version
        )
        assert body["trainingKind"] == "observed"
        assert body["transitional"] is False

    def test_default_model_path_is_the_current_artifact(self) -> None:
        settings = Settings(_env_file=None, APP_ENV="test", MODEL_PROVIDER="baseline")
        assert settings.resolved_model_path == ARTIFACT_PATH

    @pytest.mark.parametrize(
        ("training", "expected"),
        [
            ("not-an-object", "not an object"),
            ({"kind": "observed"}, "without both kind and transitional"),
            ({"transitional": False}, "without both kind and transitional"),
            ({"kind": "observed", "transitional": "yes"}, "non-boolean"),
            ({"kind": "", "transitional": False}, "non-empty string"),
            (
                {"kind": "guessed", "transitional": False},
                "training.kind must be one of",
            ),
            # An observed claim must carry what makes it checkable.
            ({"kind": "observed", "transitional": False}, "no training.datasetVersion"),
            (
                {"kind": "observed", "transitional": False, "datasetVersion": 3},
                "non-empty string",
            ),
            ({**OBSERVED_PROVENANCE, "datasetChecksum": "abc"}, "64 hexadecimal"),
            ({**OBSERVED_PROVENANCE, "durationDaysGrid": [0]}, "positive integers"),
            ({**OBSERVED_PROVENANCE, "thresholdMmGrid": []}, "must not be empty"),
            # An observed model must name where its data came from; an empty
            # container is not a name.
            (
                {k: v for k, v in OBSERVED_PROVENANCE.items() if k != "source"},
                "no training.source",
            ),
            ({**OBSERVED_PROVENANCE, "source": []}, "not an object"),
            (
                {**OBSERVED_PROVENANCE, "source": {"provider": "x"}},
                "training.source.url",
            ),
            (
                {
                    **OBSERVED_PROVENANCE,
                    "dateRange": {"start": "1995-01-01", "end": "yesterday"},
                },
                "calendar date",
            ),
        ],
    )
    def test_rejects_malformed_provenance(
        self, tmp_path, training, expected: str
    ) -> None:
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        payload["training"] = training
        payload["checksum"] = compute_checksum(payload)
        path = tmp_path / "bad.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

        with pytest.raises(ModelArtifactError, match=expected):
            load_artifact(path)

    def test_an_artifact_without_provenance_still_loads(self, tmp_path) -> None:
        # The contract predates the field; an older artifact is loadable, it
        # simply cannot say what it was trained on — and "cannot say" is
        # recorded as unknown, not as a reassuring default.
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        del payload["training"]
        payload["checksum"] = compute_checksum(payload)
        path = tmp_path / "bare.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

        artifact = load_artifact(path)
        assert artifact.dataset_version is None
        assert artifact.training_kind is None
        assert artifact.transitional is None
        assert artifact.is_within_trained_domain(30, 50) is False

    def test_the_current_artifact_records_its_training_grid(self) -> None:
        artifact = load_artifact(ARTIFACT_PATH)
        assert artifact.trained_duration_days == (7, 365)
        assert artifact.trained_threshold_mm == (10, 300)

    def test_the_archived_observed_release_still_loads_without_a_season(self) -> None:
        # The previous observed model predates the seasonal term and the
        # evidence floor; it loads, prices without them, and says what it is.
        previous = load_artifact(
            MODULE_ROOT / "app/models/artifacts/archive/baseline-premium-v2.json"
        )
        assert previous.training_kind == "observed"
        assert "season_risk" not in previous.features
        assert previous.season_risk == {}
        assert previous.evidence_floor == {}

    @pytest.mark.parametrize(
        ("mutate", "expected"),
        [
            (lambda p: p.pop("seasonRisk"), "carries no seasonRisk"),
            (
                lambda p: (
                    p.__setitem__("features", p["features"][:4]),
                    p.__setitem__("coefficients", p["coefficients"][:4]),
                ),
                "does not list the season_risk feature",
            ),
            (lambda p: p["seasonRisk"]["lima"].pop(), "12 monthly offsets"),
            (lambda p: p["seasonRisk"].pop("lima"), "cover exactly the regions"),
            (lambda p: p["seasonRisk"]["lima"].__setitem__(0, "0.1"), "JSON number"),
            (
                lambda p: p["evidenceFloor"].__setitem__("atlantis", [[7, 10, 0.5]]),
                "does not know",
            ),
            (
                lambda p: p["evidenceFloor"]["valencia"].append([7, 10, 1.5]),
                "must be a probability",
            ),
            (
                lambda p: p["evidenceFloor"]["valencia"].append([0, 10, 0.5]),
                "positive integer",
            ),
            (
                lambda p: p["evidenceFloor"]["valencia"].append(
                    list(p["evidenceFloor"]["valencia"][0])
                ),
                "repeats the cell",
            ),
        ],
    )
    def test_rejects_malformed_season_or_evidence(
        self, tmp_path, mutate, expected
    ) -> None:
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        mutate(payload)
        payload["checksum"] = compute_checksum(payload)
        path = tmp_path / "bad.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

        with pytest.raises(ModelArtifactError, match=expected):
            load_artifact(path)


class TestDeployedProfiles:
    """
    A deployed profile prices real coverage, so it may only serve a model
    fitted to observed data that says so. Development and test may load
    anything, which is how the archived synthetic artifact stays testable.
    """

    @staticmethod
    def _settings(profile: str, path, **extra) -> Settings:
        return Settings(
            _env_file=None,
            APP_ENV=profile,
            MODEL_PROVIDER="baseline",
            MODEL_PATH=str(path),
            **extra,
        )

    @pytest.mark.parametrize("profile", ["staging", "testnet", "production"])
    def test_refuses_the_transitional_model(self, profile: str) -> None:
        with (
            pytest.raises(
                ModelArtifactError, match="not an observed, non-transitional"
            ),
            TestClient(create_app(self._settings(profile, PREVIOUS_PATH))),
        ):
            pass

    def test_refuses_an_artifact_that_makes_no_claim(self, tmp_path) -> None:
        # Unknown provenance is not the same as clean provenance.
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        del payload["training"]
        payload["checksum"] = compute_checksum(payload)
        path = tmp_path / "bare.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

        with (
            pytest.raises(ModelArtifactError, match="transitional=None"),
            TestClient(create_app(self._settings("production", path))),
        ):
            pass

    @pytest.mark.parametrize("profile", ["staging", "testnet", "production"])
    def test_serves_the_observed_model(self, profile: str) -> None:
        with TestClient(create_app(self._settings(profile, ARTIFACT_PATH))) as client:
            body = client.get("/health/ready").json()
        assert body["status"] == "ready"
        assert body["model"]["trainingKind"] == "observed"
        assert body["model"]["transitional"] is False

    def test_development_still_loads_the_archive(self) -> None:
        with TestClient(create_app(self._settings("development", PREVIOUS_PATH))) as c:
            body = c.get("/health/ready").json()["model"]
        assert body["trainingKind"] == "synthetic"
        assert body["transitional"] is True

    def test_the_override_is_explicit_and_stays_visible(self, caplog) -> None:
        # The one way to serve a placeholder in production: named, logged, and
        # still reported by readiness as what it is.
        settings = self._settings(
            "production", PREVIOUS_PATH, MODEL_ALLOW_TRANSITIONAL="true"
        )
        with (
            caplog.at_level(logging.WARNING, logger="climatechain.ml"),
            TestClient(create_app(settings)) as client,
        ):
            body = client.get("/health/ready").json()["model"]

        assert body["transitional"] is True
        assert any("MODEL_ALLOW_TRANSITIONAL" in r.getMessage() for r in caplog.records)
