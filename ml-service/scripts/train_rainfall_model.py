"""
Trains the pricing model from the committed rainfall history and writes the
artifact the Stage 07 runtime loads.

This replaces the Stage 07 build script, which fitted the same model family to
synthetic rainfall so that the loading lifecycle could be exercised before real
data existed. The model family and the artifact contract are unchanged — the
runtime reads this artifact without modification — and what changes is the
evidence behind the coefficients.

Reproducible by construction: the dataset is committed and checksummed, the
split is by calendar date, the fit is a deterministic least-squares solve, and
the artifact records the hash of the configuration and of this script. Running
it twice yields byte-identical output; the gate depends on that.

Evaluation is time-based. The model is fitted on 1995-2018 and scored on
2019-2024 it never saw, using the runtime's own evaluator so the metrics
describe the deployed code path rather than a re-implementation of it. The
previous artifact is scored on the same holdout, which is what makes the
numbers comparable rather than merely reported.

Two modes. Without flags it *releases*: writes the artifact and its metrics.
With `--check` it writes nothing and fails if what it would produce differs
from the committed files — which is what the gate runs, so the gate can never
create or replace an artifact as a side effect of verifying one.

Usage:
    python scripts/train_rainfall_model.py [--dataset PATH] [--output PATH]
    python scripts/train_rainfall_model.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path

import numpy as np

MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

from app.data.rainfall import (  # noqa: E402
    RainfallDataset,
    day_index,
    load_rainfall_dataset,
)
from app.models.artifact import (  # noqa: E402
    SUPPORTED_SCHEMA_VERSION,
    ModelArtifact,
    ModelArtifactError,
    compute_checksum,
    load_artifact,
)
from app.models.baseline import PricingInputs, assess_risk  # noqa: E402

MODEL_VERSION = "baseline-premium-v2"
ARTIFACTS_DIR = MODULE_ROOT / "app/models/artifacts"
DEFAULT_DATASET = MODULE_ROOT / "data/rainfall-history-v1.json"
DEFAULT_OUTPUT = ARTIFACTS_DIR / f"{MODEL_VERSION}.json"
DEFAULT_METRICS = ARTIFACTS_DIR / f"{MODEL_VERSION}.metrics.json"
PREVIOUS_ARTIFACT = ARTIFACTS_DIR / "archive/baseline-premium-v1.json"

# The grid trigger frequency is measured over. Identical to Stage 07's so the
# two artifacts are estimated on the same design and the comparison is fair.
DURATION_DAYS_GRID = (7, 14, 30, 60, 90, 180, 365)
THRESHOLD_MM_GRID = (10, 20, 30, 50, 80, 120, 200, 300)

# Time-based split on whole years. The holdout is the most recent six years:
# the period a deployed model would actually be pricing into.
TRAIN_END = date(2018, 12, 31)
TEST_START = date(2019, 1, 1)

# Margin over expected loss. A commercial choice carried over unchanged from
# Stage 07; nothing in the data can decide it.
PREMIUM_LOADING = 0.35

# Log-odds are undefined at exactly 0 or 1; frequencies are clamped inside.
FREQUENCY_FLOOR = 0.002
FREQUENCY_CEILING = 0.98

FEATURES = ("intercept", "log_threshold_mm", "log_duration_days", "region_risk")


@dataclass(frozen=True)
class Split:
    """Series positions for one part of the time split."""

    label: str
    start_index: int
    end_index: int  # exclusive


def make_splits(dataset: RainfallDataset) -> tuple[Split, Split]:
    if not (dataset.start <= TRAIN_END < TEST_START <= dataset.end):
        raise SystemExit(
            f"Split {TRAIN_END}/{TEST_START} does not lie inside the dataset range "
            f"{dataset.start}..{dataset.end}"
        )
    train = Split("train", 0, day_index(dataset, TRAIN_END) + 1)
    test = Split("test", day_index(dataset, TEST_START), dataset.days)
    return train, test


def window_outcomes(
    series: tuple[float, ...], split: Split, duration: int, threshold: int
) -> np.ndarray:
    """
    One boolean per non-overlapping window: did rainfall reach the threshold?

    Non-overlapping so windows share no days; overlapping ones would count the
    same wet day many times and understate the variance of every estimate.
    """
    values = np.asarray(series[split.start_index : split.end_index], dtype=float)
    usable = (len(values) // duration) * duration
    if usable == 0:
        return np.zeros(0, dtype=bool)
    maxima = values[:usable].reshape(-1, duration).max(axis=1)
    return maxima >= threshold


def region_risks(dataset: RainfallDataset, split: Split) -> dict[str, float]:
    """
    Mean daily rainfall per region, on the training period only.

    The same quantity Stage 07 assigned by hand from a table; here it is
    measured. Computed on the training split so the holdout evaluation does
    not see its own summary statistics.
    """
    return {
        key: round(
            float(np.mean(series.mm_per_day[split.start_index : split.end_index])), 6
        )
        for key, series in dataset.regions.items()
    }


def fit(dataset: RainfallDataset, train: Split, risks: dict[str, float]) -> np.ndarray:
    """Least-squares fit of trigger log-odds on the training grid."""
    rows: list[list[float]] = []
    log_odds: list[float] = []

    for key, series in dataset.regions.items():
        for duration in DURATION_DAYS_GRID:
            for threshold in THRESHOLD_MM_GRID:
                outcomes = window_outcomes(
                    series.mm_per_day, train, duration, threshold
                )
                if len(outcomes) == 0:
                    continue
                frequency = float(outcomes.mean())
                frequency = min(max(frequency, FREQUENCY_FLOOR), FREQUENCY_CEILING)
                rows.append([1.0, math.log(threshold), math.log(duration), risks[key]])
                log_odds.append(math.log(frequency / (1.0 - frequency)))

    design = np.asarray(rows, dtype=float)
    target = np.asarray(log_odds, dtype=float)
    coefficients, *_ = np.linalg.lstsq(design, target, rcond=None)
    return coefficients


def in_memory_artifact(
    coefficients: tuple[float, ...],
    risks: dict[str, float],
    default_risk: float,
    label: str,
) -> ModelArtifact:
    """A model as the runtime would hold it, so evaluation uses its evaluator."""
    return ModelArtifact(
        model_version=label,
        provider="baseline",
        features=FEATURES,
        coefficients=coefficients,
        region_risk=dict(risks),
        default_region_risk=default_risk,
        premium_loading=PREMIUM_LOADING,
        source_path=Path("<memory>"),
        checksum="",
        dataset_version=None,
        training_kind=None,
        transitional=None,
    )


def _score(predicted: list[float], observed: list[float]) -> dict:
    """Proper scores plus the two rates that make calibration visible."""
    p = np.asarray(predicted, dtype=float)
    y = np.asarray(observed, dtype=float)
    losses = -(y * np.log(p) + (1 - y) * np.log(1 - p))
    return {
        "windows": len(p),
        "logLoss": round(float(np.mean(losses)), 6),
        "brier": round(float(np.mean((p - y) ** 2)), 6),
        "observedTriggerRate": round(float(np.mean(y)), 6),
        "predictedTriggerRate": round(float(np.mean(p)), 6),
    }


def evaluate(artifact: ModelArtifact, dataset: RainfallDataset, test: Split) -> dict:
    """
    Scores a model on the holdout with the runtime's own `assess_risk`.

    Log-loss and Brier score over every holdout window in the grid; both are
    proper scoring rules, so a model cannot improve them by hedging. The
    observed and predicted trigger rates are reported alongside so a
    miscalibrated model is visible even when its ranking is fine — and they
    are reported per region as well as in aggregate, because an aggregate can
    hide one region priced badly behind seven priced well.
    """
    all_predicted: list[float] = []
    all_observed: list[float] = []
    by_region: dict[str, dict] = {}

    for key, series in dataset.regions.items():
        predicted: list[float] = []
        observed: list[float] = []
        for duration in DURATION_DAYS_GRID:
            for threshold in THRESHOLD_MM_GRID:
                outcomes = window_outcomes(series.mm_per_day, test, duration, threshold)
                if len(outcomes) == 0:
                    continue
                probability = assess_risk(
                    artifact,
                    PricingInputs(
                        region=key,
                        rainfall_threshold_mm=threshold,
                        duration_days=duration,
                    ),
                ).trigger_probability
                predicted.extend([probability] * len(outcomes))
                observed.extend(1.0 if outcome else 0.0 for outcome in outcomes)
        if predicted:
            by_region[key] = _score(predicted, observed)
            all_predicted.extend(predicted)
            all_observed.extend(observed)

    return {**_score(all_predicted, all_observed), "byRegion": by_region}


def previous_model_metrics(dataset: RainfallDataset, test: Split) -> dict | None:
    """Scores the archived Stage 07 artifact on the same holdout, if present."""
    if not PREVIOUS_ARTIFACT.is_file():
        return None
    try:
        previous = load_artifact(PREVIOUS_ARTIFACT)
    except ModelArtifactError as error:
        raise SystemExit(
            f"Archived previous artifact is unreadable: {error}"
        ) from error
    metrics = evaluate(previous, dataset, test)
    return {
        "modelVersion": previous.model_version,
        "trainingKind": previous.training_kind,
        "checksum": previous.checksum,
        **metrics,
    }


def source_fingerprint(raw: bytes) -> str:
    """
    Hash of source text, indifferent to line endings.

    A checkout that converts LF to CRLF has not changed the training procedure,
    and must not change the artifact. `.gitattributes` pins LF for Python as
    well; this is the half that holds even where that is overridden.
    """
    return hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()


def config_hash(dataset: RainfallDataset) -> str:
    """
    Fingerprint of everything that determines the fit.

    Includes a hash of this script rather than a git commit: a commit hash
    changes on every commit and would make the artifact drift on unrelated
    changes, while the script hash changes exactly when the training procedure
    does — which is when the artifact genuinely needs rebuilding.
    """
    config = {
        "datasetVersion": dataset.dataset_version,
        "datasetChecksum": dataset.checksum,
        "trainEnd": TRAIN_END.isoformat(),
        "testStart": TEST_START.isoformat(),
        "durationDaysGrid": list(DURATION_DAYS_GRID),
        "thresholdMmGrid": list(THRESHOLD_MM_GRID),
        "premiumLoading": PREMIUM_LOADING,
        "frequencyFloor": FREQUENCY_FLOOR,
        "frequencyCeiling": FREQUENCY_CEILING,
        "features": list(FEATURES),
        "trainerSha256": source_fingerprint(Path(__file__).read_bytes()),
    }
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_payload(
    dataset: RainfallDataset,
    coefficients: np.ndarray,
    risks: dict[str, float],
    train: Split,
    test: Split,
    holdout: dict,
    previous: dict | None,
) -> dict:
    default_risk = round(sum(risks.values()) / len(risks), 6)
    payload = {
        "schemaVersion": SUPPORTED_SCHEMA_VERSION,
        "modelVersion": MODEL_VERSION,
        "provider": "baseline",
        "createdAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "features": list(FEATURES),
        "coefficients": [round(float(value), 12) for value in coefficients],
        "regionRisk": dict(sorted(risks.items())),
        "defaultRegionRisk": default_risk,
        "premiumLoading": PREMIUM_LOADING,
        "training": {
            "kind": "observed",
            "transitional": False,
            "note": (
                "Fitted to ERA5 daily precipitation for the listed regions; "
                "evaluated on a held-out period the fit never saw."
            ),
            "datasetVersion": dataset.dataset_version,
            "datasetChecksum": dataset.checksum,
            "source": dataset.source,
            "dateRange": {
                "start": dataset.start.isoformat(),
                "end": dataset.end.isoformat(),
            },
            "split": {
                "trainEnd": TRAIN_END.isoformat(),
                "testStart": TEST_START.isoformat(),
                "trainDays": train.end_index - train.start_index,
                "testDays": test.end_index - test.start_index,
            },
            "durationDaysGrid": list(DURATION_DAYS_GRID),
            "thresholdMmGrid": list(THRESHOLD_MM_GRID),
            "configHash": config_hash(dataset),
            "metrics": {"holdout": holdout, "previousModel": previous},
        },
    }
    payload["checksum"] = compute_checksum(payload)
    return payload


def _preserve_created_at(payload: dict, output: Path) -> dict:
    if not output.is_file():
        return payload
    try:
        existing = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return payload
    ignored = ("createdAt", "checksum")
    if {k: v for k, v in payload.items() if k not in ignored} != {
        k: v for k, v in existing.items() if k not in ignored
    }:
        return payload
    if "createdAt" not in existing:
        return payload
    payload["createdAt"] = existing["createdAt"]
    payload["checksum"] = compute_checksum(payload)
    return payload


def render_json(payload: dict) -> bytes:
    """The exact bytes a file holds, so check mode compares what release writes."""
    return (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(render_json(payload))


def check_against_committed(
    artifact_payload: dict, metrics_payload: dict, output: Path, metrics: Path
) -> None:
    """
    Fails when the committed files are not what this run would write.

    A missing file is a failure too: the gate must never be the thing that
    creates an artifact, because then a deleted artifact would be silently
    regenerated instead of noticed.
    """
    problems: list[str] = []
    for label, path, rendered in (
        ("artifact", output, render_json(artifact_payload)),
        ("metrics", metrics, render_json(metrics_payload)),
    ):
        if not path.is_file():
            problems.append(
                f"{label} {path} does not exist; produce it deliberately by "
                f"running this script without --check"
            )
        elif path.read_bytes() != rendered:
            problems.append(
                f"{label} {path} differs from what the committed dataset and this "
                f"trainer produce"
            )
    if problems:
        raise SystemExit("training drift:\n  " + "\n  ".join(problems))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--metrics", type=Path, default=DEFAULT_METRICS)
    parser.add_argument(
        "--check",
        action="store_true",
        help="write nothing; fail unless the committed files match a fresh run",
    )
    args = parser.parse_args()

    dataset = load_rainfall_dataset(args.dataset)
    train, test = make_splits(dataset)
    risks = region_risks(dataset, train)
    coefficients = fit(dataset, train, risks)

    candidate = in_memory_artifact(
        tuple(round(float(v), 12) for v in coefficients),
        risks,
        round(sum(risks.values()) / len(risks), 6),
        MODEL_VERSION,
    )
    holdout = evaluate(candidate, dataset, test)
    previous = previous_model_metrics(dataset, test)

    payload = _preserve_created_at(
        build_payload(dataset, coefficients, risks, train, test, holdout, previous),
        args.output,
    )
    metrics_payload = {
        "modelVersion": MODEL_VERSION,
        "datasetVersion": dataset.dataset_version,
        "split": payload["training"]["split"],
        "holdout": holdout,
        "previousModel": previous,
    }

    if args.check:
        check_against_committed(payload, metrics_payload, args.output, args.metrics)
        print(
            f"check OK: {args.output.name} and {args.metrics.name} match a fresh "
            f"run (checksum {payload['checksum'][:12]}...)"
        )
        return

    write_json(args.output, payload)
    write_json(args.metrics, metrics_payload)

    # Prove the file on disk is what the runtime will accept, not just the dict.
    load_artifact(args.output)

    print(f"Model:        {MODEL_VERSION}")
    print(f"Dataset:      {dataset.dataset_version} ({dataset.checksum[:12]}...)")
    print(f"Train/test:   {dataset.start}..{TRAIN_END} / {TEST_START}..{dataset.end}")
    print("Coefficients:")
    for name, value in zip(FEATURES, payload["coefficients"], strict=True):
        print(f"  {name:<20} {value: .6f}")
    print("Region risk (mean mm/day, train period):")
    for key, value in payload["regionRisk"].items():
        print(f"  {key:<14} {value:.3f}")
    print(
        f"Holdout:      logLoss={holdout['logLoss']:.4f} brier={holdout['brier']:.4f} "
        f"observed={holdout['observedTriggerRate']:.4f} "
        f"predicted={holdout['predictedTriggerRate']:.4f} "
        f"windows={holdout['windows']}"
    )
    if previous:
        print(
            f"Previous ({previous['modelVersion']}, {previous['trainingKind']}): "
            f"logLoss={previous['logLoss']:.4f} brier={previous['brier']:.4f} "
            f"predicted={previous['predictedTriggerRate']:.4f}"
        )
    print(f"Checksum:     {payload['checksum']}")
    print(f"Written:      {args.output}")


if __name__ == "__main__":
    main()
