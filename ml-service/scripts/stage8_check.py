"""
The Stage 08 gate: everything Stage 07 verified, plus the training pipeline.

Stage 07 proved the runtime could load and serve an artifact. Stage 08 proves
the artifact is the reproducible product of a committed dataset: the data has
not changed under its checksum, the regions the model knows are the regions the
data covers, and retraining from that data yields the committed artifact byte
for byte. Nothing here reaches the network — the fetch is a deliberate,
separate act, and a gate that could pass or fail on a remote service's mood is
not a gate.

Steps, in the order a failure is cheapest to diagnose:

1. Lint and format.
2. Dataset integrity: checksum, shape, and agreement with the region registry.
3. Retrain and fail on drift, for the artifact and for the metrics file.
4. Tests, including the runtime's view of the model's provenance.
5. A real startup serving a quote from the retrained artifact.

Usage:
    python scripts/stage8_check.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

from app.data.rainfall import RainfallDatasetError, load_rainfall_dataset  # noqa: E402
from app.models.artifact import ModelArtifactError, load_artifact  # noqa: E402

DATASET = MODULE_ROOT / "data/rainfall-history-v1.json"
REGIONS = MODULE_ROOT / "data/regions.json"
ARTIFACT = MODULE_ROOT / "app/models/artifacts/baseline-premium-v2.json"
METRICS = MODULE_ROOT / "app/models/artifacts/baseline-premium-v2.metrics.json"
PREVIOUS = MODULE_ROOT / "app/models/artifacts/archive/baseline-premium-v1.json"


def run(label: str, command: list[str]) -> None:
    print(f"\n=== {label} ===", flush=True)
    result = subprocess.run(command, cwd=MODULE_ROOT)
    if result.returncode != 0:
        raise SystemExit(f"stage8:check FAILED at: {label}")


def check_dataset() -> None:
    print("\n=== dataset integrity ===", flush=True)
    try:
        dataset = load_rainfall_dataset(DATASET)
    except RainfallDatasetError as error:
        raise SystemExit(f"stage8:check FAILED: {error}") from error

    registry = json.loads(REGIONS.read_text(encoding="utf-8"))["regions"]
    registered = set(registry)
    covered = set(dataset.regions)
    if registered != covered:
        raise SystemExit(
            "stage8:check FAILED: data/regions.json and the dataset disagree on "
            f"regions. Only in registry: {sorted(registered - covered) or 'none'}. "
            f"Only in dataset: {sorted(covered - registered) or 'none'}. Re-run "
            "scripts/fetch_rainfall_history.py after changing the registry."
        )

    for key, entry in registry.items():
        series = dataset.regions[key]
        if (series.latitude, series.longitude) != (
            entry["latitude"],
            entry["longitude"],
        ):
            raise SystemExit(
                f"stage8:check FAILED: region {key!r} was fetched at "
                f"({series.latitude}, {series.longitude}) but the registry now says "
                f"({entry['latitude']}, {entry['longitude']}). Refetch."
            )

    print(
        f"{dataset.dataset_version}: {len(dataset.regions)} regions, "
        f"{dataset.days} days ({dataset.start}..{dataset.end}), checksum verified, "
        f"registry consistent."
    )


def check_training_drift() -> None:
    print("\n=== training drift ===", flush=True)
    before_artifact = ARTIFACT.read_bytes() if ARTIFACT.is_file() else None
    before_metrics = METRICS.read_bytes() if METRICS.is_file() else None

    result = subprocess.run(
        [sys.executable, "scripts/train_rainfall_model.py"],
        cwd=MODULE_ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr)
        raise SystemExit("stage8:check FAILED at: retraining the model")

    if before_artifact is not None and before_artifact != ARTIFACT.read_bytes():
        raise SystemExit(
            "stage8:check FAILED: the committed artifact does not match what "
            "scripts/train_rainfall_model.py produces from the committed dataset. "
            "Commit the retrained artifact, or revert the change that caused it."
        )
    if before_metrics is not None and before_metrics != METRICS.read_bytes():
        raise SystemExit(
            "stage8:check FAILED: the committed metrics file does not match a "
            "fresh evaluation. Commit the regenerated metrics."
        )

    # The artifact the runtime will load, checked as the runtime checks it, and
    # the provenance the stage exists to establish.
    try:
        artifact = load_artifact(ARTIFACT)
    except ModelArtifactError as error:
        raise SystemExit(f"stage8:check FAILED: {error}") from error
    if artifact.transitional or artifact.training_kind != "observed":
        raise SystemExit(
            "stage8:check FAILED: the current artifact must be trained on observed "
            f"data and not transitional; got kind={artifact.training_kind!r}, "
            f"transitional={artifact.transitional}"
        )
    if not PREVIOUS.is_file():
        raise SystemExit(
            "stage8:check FAILED: the archived previous artifact is missing, so "
            "the holdout comparison cannot be reproduced."
        )

    metrics = json.loads(METRICS.read_text(encoding="utf-8"))
    holdout = metrics["holdout"]
    previous = metrics["previousModel"]
    print(
        f"Retrained {artifact.model_version} from {artifact.dataset_version}: "
        f"byte-identical. Holdout logLoss={holdout['logLoss']} "
        f"brier={holdout['brier']} (previous {previous['modelVersion']}: "
        f"logLoss={previous['logLoss']} brier={previous['brier']})."
    )


def main() -> None:
    run("lint", [sys.executable, "-m", "ruff", "check", "."])
    run("format", [sys.executable, "-m", "ruff", "format", "--check", "."])
    check_dataset()
    check_training_drift()
    run("tests", [sys.executable, "-m", "pytest"])
    run("runtime startup", [sys.executable, "scripts/startup_check.py"])

    print("\nstage8:check OK")


if __name__ == "__main__":
    main()
