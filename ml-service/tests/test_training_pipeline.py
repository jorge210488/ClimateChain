"""
The training pipeline: dataset integrity, the fit, and what the runtime sees.

Nothing here reaches the network. The dataset under test is the committed one
the fetch script produced; its provenance is part of what these tests verify.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.data.rainfall import (
    RainfallDatasetError,
    date_at,
    day_index,
    expected_day_count,
    load_rainfall_dataset,
)
from app.main import create_app
from app.models.artifact import ModelArtifactError, compute_checksum, load_artifact
from tests.conftest_helpers import ARTIFACT_PATH, MODULE_ROOT

DATASET_PATH = MODULE_ROOT / "data/rainfall-history-v1.json"
REGIONS_PATH = MODULE_ROOT / "data/regions.json"
METRICS_PATH = MODULE_ROOT / "app/models/artifacts/baseline-premium-v2.metrics.json"
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
        assert dataset.dataset_version == "rainfall-history-v1"
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


class TestFetchValidation:
    """The fetch script's own checks, exercised on fabricated payloads."""

    def test_payload_carries_provenance_and_a_checksum(self, fetcher) -> None:
        regions = {
            "lima": {
                "name": "Lima",
                "country": "PE",
                "latitude": -12.0,
                "longitude": -77.0,
            }
        }
        series = {"lima": [0.0] * expected_day_count(fetcher.START, fetcher.END)}
        payload = fetcher.build_payload(regions, series)

        assert payload["datasetVersion"] == "rainfall-history-v1"
        assert payload["days"] == len(series["lima"])
        assert payload["checksum"] == compute_checksum(payload)

    def test_a_refresh_that_changes_nothing_keeps_its_timestamp(
        self, tmp_path, fetcher
    ) -> None:
        # So `git status` reports a real change in the source, never a re-run.
        regions = {
            "lima": {
                "name": "Lima",
                "country": "PE",
                "latitude": -12.0,
                "longitude": -77.0,
            }
        }
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


class TestTraining:
    def test_split_is_by_calendar_and_disjoint(self, trainer, dataset) -> None:
        train, test = trainer.make_splits(dataset)
        assert train.end_index == test.start_index
        assert date_at(dataset, train.end_index - 1) == trainer.TRAIN_END
        assert date_at(dataset, test.start_index) == trainer.TEST_START

    def test_windows_do_not_overlap(self, trainer, dataset) -> None:
        train, _ = trainer.make_splits(dataset)
        series = dataset.regions["medellin"].mm_per_day
        outcomes = trainer.window_outcomes(series, train, 30, 50)
        days_in_split = train.end_index - train.start_index
        assert len(outcomes) == days_in_split // 30

    def test_region_risk_is_measured_on_the_training_period_only(
        self, trainer, dataset
    ) -> None:
        # No leakage: the holdout must not shape the features it is scored on.
        train, _ = trainer.make_splits(dataset)
        risks = trainer.region_risks(dataset, train)
        series = dataset.regions["lima"].mm_per_day[train.start_index : train.end_index]
        assert risks["lima"] == pytest.approx(sum(series) / len(series), abs=1e-6)

    def test_retraining_reproduces_the_committed_artifact(
        self, trainer, dataset
    ) -> None:
        # The reproducibility criterion, as a unit test rather than only a gate.
        train, _ = trainer.make_splits(dataset)
        risks = trainer.region_risks(dataset, train)
        coefficients = [round(float(v), 12) for v in trainer.fit(dataset, train, risks)]
        committed = load_artifact(ARTIFACT_PATH)
        assert list(committed.coefficients) == coefficients
        assert committed.region_risk == risks

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
        # Calibration in aggregate: the model predicts about as many triggers
        # as actually happened in six years it never saw.
        assert (
            abs(holdout["predictedTriggerRate"] - holdout["observedTriggerRate"]) < 0.02
        )

    def test_beats_the_synthetic_model_on_the_same_holdout(self) -> None:
        # The falsifiable claim behind this stage: real data prices real risk
        # better than invented data did. Scored by the same evaluator, on the
        # same windows, so the comparison is between models and nothing else.
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        holdout, previous = metrics["holdout"], metrics["previousModel"]
        assert previous is not None
        assert previous["trainingKind"] == "synthetic"
        assert holdout["logLoss"] < previous["logLoss"]
        assert holdout["brier"] < previous["brier"]

    def test_the_synthetic_model_underpriced_real_risk(self) -> None:
        # Recorded because it is the reason Stage 08 exists, not merely a score:
        # the placeholder would have predicted far fewer payouts than occurred.
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        holdout, previous = metrics["holdout"], metrics["previousModel"]
        assert previous["predictedTriggerRate"] < holdout["observedTriggerRate"] / 2

    def test_artifact_metrics_match_the_metrics_file(self) -> None:
        artifact = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        assert artifact["training"]["metrics"]["holdout"] == metrics["holdout"]
        assert artifact["training"]["datasetVersion"] == metrics["datasetVersion"]

    def test_config_hash_tracks_the_trainer_itself(self, trainer, dataset) -> None:
        artifact = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        assert artifact["training"]["configHash"] == trainer.config_hash(dataset)


class TestProvenanceInTheRuntime:
    def test_current_artifact_is_observed_and_not_transitional(self) -> None:
        artifact = load_artifact(ARTIFACT_PATH)
        assert artifact.training_kind == "observed"
        assert artifact.transitional is False
        assert artifact.dataset_version == "rainfall-history-v1"

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
        assert body["datasetVersion"] == "rainfall-history-v1"
        assert body["trainingKind"] == "observed"
        assert body["transitional"] is False

    def test_default_model_path_is_the_current_artifact(self) -> None:
        settings = Settings(_env_file=None, APP_ENV="test", MODEL_PROVIDER="baseline")
        assert settings.resolved_model_path == ARTIFACT_PATH

    @pytest.mark.parametrize(
        ("training", "expected"),
        [
            ("not-an-object", "not an object"),
            ({"transitional": "yes"}, "non-boolean"),
            ({"kind": ""}, "non-empty string"),
            ({"datasetVersion": 3}, "non-empty string"),
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
        # simply cannot say what it was trained on.
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        del payload["training"]
        payload["checksum"] = compute_checksum(payload)
        path = tmp_path / "bare.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

        artifact = load_artifact(path)
        assert artifact.dataset_version is None
        assert artifact.transitional is False
