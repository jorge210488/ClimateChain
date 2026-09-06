"""
The Stage 08 gate: everything Stage 07 verified, plus the training pipeline.

Stage 07 proved the runtime could load and serve an artifact. Stage 08 proves
the artifact is the reproducible product of a committed dataset: the data has
not changed under its checksum, the regions the model knows are the regions the
data covers, and retraining from that data yields the committed artifact byte
for byte. Nothing here reaches the network — the fetch is a deliberate,
separate act, and a gate that could pass or fail on a remote service's mood is
not a gate.

The gate writes nothing. Retraining runs in check mode, which compares what the
trainer would produce against the committed files and refuses to create or
replace either; a missing artifact is a failure, not something to regenerate
quietly. Producing a new artifact is a release, done on purpose with
`python scripts/train_rainfall_model.py`.

Steps, in the order a failure is cheapest to diagnose:

1. Lint and format.
2. Dataset integrity: checksum, shape, and agreement with the region registry.
3. Retrain in check mode and fail on drift, for the artifact and the metrics.
4. Tests, including the runtime's view of the model's provenance.
5. A real startup serving a quote from the committed artifact.

Usage:
    python scripts/stage8_check.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

from app.data.rainfall import (  # noqa: E402
    MAX_DATASET_AGE_YEARS,
    RainfallDatasetError,
    dataset_age_years,
    load_rainfall_dataset,
)
from app.data.regions import RegionRegistryError, load_region_registry  # noqa: E402
from app.models.artifact import ModelArtifactError, load_artifact  # noqa: E402

DATASET = MODULE_ROOT / "data/rainfall-history.json"
REGIONS = MODULE_ROOT / "data/regions.json"
ARTIFACT = MODULE_ROOT / "app/models/artifacts/baseline-premium-v3.json"
METRICS = MODULE_ROOT / "app/models/artifacts/baseline-premium-v3.metrics.json"
ARCHIVE = MODULE_ROOT / "app/models/artifacts/archive"
# Every superseded model, scored on the same holdout as the current one: the
# synthetic placeholder and the last observed release.
EXPECTED_ARCHIVE = ("baseline-premium-v1.json", "baseline-premium-v2.json")


def run(label: str, command: list[str]) -> None:
    print(f"\n=== {label} ===", flush=True)
    result = subprocess.run(command, cwd=MODULE_ROOT)
    if result.returncode != 0:
        raise SystemExit(f"stage8:check FAILED at: {label}")


def check_dataset() -> None:
    print("\n=== dataset integrity ===", flush=True)
    try:
        dataset = load_rainfall_dataset(DATASET)
        registry = load_region_registry(REGIONS)
    except (RainfallDatasetError, RegionRegistryError) as error:
        raise SystemExit(f"stage8:check FAILED: {error}") from error

    registered = set(registry)
    covered = set(dataset.regions)
    if registered != covered:
        raise SystemExit(
            "stage8:check FAILED: data/regions.json and the dataset disagree on "
            f"regions. Only in registry: {sorted(registered - covered) or 'none'}. "
            f"Only in dataset: {sorted(covered - registered) or 'none'}. Re-run "
            "scripts/fetch_rainfall_history.py after changing the registry."
        )

    for key, region in registry.items():
        series = dataset.regions[key]
        if (series.latitude, series.longitude) != (region.latitude, region.longitude):
            raise SystemExit(
                f"stage8:check FAILED: region {key!r} was fetched at "
                f"({series.latitude}, {series.longitude}) but the registry now says "
                f"({region.latitude}, {region.longitude}). Refetch."
            )

    # Freshness is part of integrity: a dataset can be perfectly intact and
    # describe a climate the model no longer prices into.
    age = dataset_age_years(dataset, datetime.now(UTC).date())
    if age > MAX_DATASET_AGE_YEARS:
        raise SystemExit(
            f"stage8:check FAILED: the dataset ends in {dataset.end.year}, "
            f"{age} complete years behind the most recent one; the policy allows "
            f"{MAX_DATASET_AGE_YEARS}. Refresh with "
            "`python scripts/fetch_rainfall_history.py`, retrain, and commit both."
        )

    print(
        f"{dataset.dataset_version}: {len(dataset.regions)} regions, "
        f"{dataset.days} days ({dataset.start}..{dataset.end}), checksum verified, "
        f"registry consistent, {age} complete year(s) behind the latest."
    )


def check_training_drift() -> None:
    print("\n=== training drift ===", flush=True)
    for label, path in (("artifact", ARTIFACT), ("metrics file", METRICS)):
        if not path.is_file():
            raise SystemExit(
                f"stage8:check FAILED: the committed {label} {path.name} is missing. "
                "The gate does not create artifacts; produce it deliberately with "
                "`python scripts/train_rainfall_model.py` and commit it."
            )
    missing_archive = [
        name for name in EXPECTED_ARCHIVE if not (ARCHIVE / name).is_file()
    ]
    if missing_archive:
        raise SystemExit(
            f"stage8:check FAILED: archived artifacts missing: {missing_archive}; "
            "the holdout comparison cannot be reproduced."
        )

    before = (ARTIFACT.read_bytes(), METRICS.read_bytes())
    result = subprocess.run(
        [sys.executable, "scripts/train_rainfall_model.py", "--check"],
        cwd=MODULE_ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr)
        raise SystemExit(
            "stage8:check FAILED: the committed artifact or metrics do not match "
            "what scripts/train_rainfall_model.py produces from the committed "
            "dataset. Retrain deliberately and commit the result, or revert the "
            "change that caused it."
        )
    if before != (ARTIFACT.read_bytes(), METRICS.read_bytes()):
        # Check mode must be read-only; if it ever is not, that is a defect in
        # the trainer, and the gate is the place to catch it.
        raise SystemExit(
            "stage8:check FAILED: `train_rainfall_model.py --check` modified the "
            "committed files. Check mode must not write."
        )

    # The artifact the runtime will load, checked as the runtime checks it, and
    # the provenance the stage exists to establish.
    try:
        artifact = load_artifact(ARTIFACT)
    except ModelArtifactError as error:
        raise SystemExit(f"stage8:check FAILED: {error}") from error
    if artifact.transitional is not False or artifact.training_kind != "observed":
        raise SystemExit(
            "stage8:check FAILED: the current artifact must be trained on observed "
            f"data and not transitional; got kind={artifact.training_kind!r}, "
            f"transitional={artifact.transitional!r}"
        )

    metrics = json.loads(METRICS.read_text(encoding="utf-8"))
    holdout = metrics["holdout"]
    previous = ", ".join(
        f"{model['modelVersion']} logLoss={model['logLoss']} "
        f"underpriced={model['cells']['underpricedWithConfidence']}"
        for model in metrics["previousModels"]
    )
    print(
        f"Retrained {artifact.model_version} from {artifact.dataset_version}: "
        f"byte-identical. Holdout logLoss={holdout['logLoss']} "
        f"brier={holdout['brier']}, cells under-priced with confidence="
        f"{holdout['cells']['underpricedWithConfidence']} (previous: {previous})."
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
