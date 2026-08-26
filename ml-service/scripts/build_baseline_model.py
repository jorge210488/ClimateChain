"""
Fits the baseline pricing model and writes its artifact.

Stage 07 must serve `/predict` from a real artifact rather than a hardcoded
response, while the data pipeline and the trained model belong to Stage 08.
This script closes that gap honestly: it generates a documented, seeded rainfall
dataset, measures how often a trigger would fire in it, and fits a model to
those measurements. The coefficients come from data, not from judgement.

**The dataset is synthetic and the resulting model is not predictive of real
climate.** It is transitional under the repository's runtime-data policy: it
exists so the loading lifecycle, readiness, and pricing arithmetic are exercised
against something real, and Stage 08 replaces the data and the fit without
changing the artifact's shape or the service that reads it.

Deterministic: the same seed produces byte-identical output, so the artifact can
be rebuilt and compared rather than trusted.

Usage:
    python scripts/build_baseline_model.py [--output PATH] [--seed N]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

from app.models.artifact import (  # noqa: E402
    SUPPORTED_SCHEMA_VERSION,
    compute_checksum,
)

MODEL_VERSION = "baseline-premium-v1"
DEFAULT_OUTPUT = MODULE_ROOT / "app/models/artifacts/baseline-premium-v1.json"
DEFAULT_SEED = 20260728

# Regions the baseline knows, with the mean daily rainfall (mm) used to generate
# their history. Wetter regions trigger a rainfall-excess policy more often and
# therefore price higher.
REGION_DAILY_RAINFALL_MM = {
    "valencia": 1.2,
    "sevilla": 0.9,
    "bogota": 3.4,
    "medellin": 4.1,
    "cartagena": 2.6,
    "lima": 0.2,
    "santiago": 0.8,
    "buenos aires": 2.9,
}

# Years of daily history generated per region.
YEARS_OF_HISTORY = 30

# Grid the trigger frequency is measured over. Windows and thresholds span the
# range the API accepts, so the fit is not extrapolating at the edges.
DURATION_DAYS_GRID = (7, 14, 30, 60, 90, 180, 365)
THRESHOLD_MM_GRID = (10, 20, 30, 50, 80, 120, 200, 300)

# Margin over expected loss. Not fitted: it is a commercial decision about how
# much the provider charges above the risk it takes, and pretending to estimate
# it from synthetic data would be dressing up a choice as a measurement.
PREMIUM_LOADING = 0.35

# Guards against a degenerate fit: an empirical frequency of exactly 0 or 1 has
# infinite log-odds, so frequencies are clamped into a representable range.
FREQUENCY_FLOOR = 0.002
FREQUENCY_CEILING = 0.98

FEATURES = ("intercept", "log_threshold_mm", "log_duration_days", "region_risk")


def generate_rainfall_history(seed: int) -> dict[str, np.ndarray]:
    """
    Generates daily rainfall per region.

    Gamma-distributed with a region-specific mean: rainfall is non-negative and
    right-skewed, which a normal distribution would not reproduce, and the skew
    is what makes high thresholds rare rather than merely smaller.
    """
    generator = np.random.default_rng(seed)
    days = YEARS_OF_HISTORY * 365

    return {
        region: generator.gamma(shape=0.6, scale=mean / 0.6, size=days)
        for region, mean in REGION_DAILY_RAINFALL_MM.items()
    }


def measure_trigger_frequencies(
    history: dict[str, np.ndarray],
) -> tuple[np.ndarray, np.ndarray]:
    """
    Measures how often a policy would have triggered, over the whole grid.

    A policy triggers when observed rainfall reaches its threshold at any point
    inside the coverage window, which is what `InsurancePolicy` checks on each
    oracle update. The window is therefore rolled across the history and the
    maximum daily rainfall in each window compared against the threshold.

    :returns: design matrix and observed frequencies, one row per grid point.
    """
    rows: list[list[float]] = []
    frequencies: list[float] = []

    for region, daily in history.items():
        region_risk = REGION_DAILY_RAINFALL_MM[region]
        for duration in DURATION_DAYS_GRID:
            # Non-overlapping windows: overlapping ones share days and would
            # understate the variance of the estimate.
            usable = (len(daily) // duration) * duration
            windows = daily[:usable].reshape(-1, duration)
            window_maxima = windows.max(axis=1)

            for threshold in THRESHOLD_MM_GRID:
                frequency = float((window_maxima >= threshold).mean())
                frequency = min(max(frequency, FREQUENCY_FLOOR), FREQUENCY_CEILING)

                rows.append(
                    [
                        1.0,
                        float(np.log(threshold)),
                        float(np.log(duration)),
                        float(region_risk),
                    ]
                )
                frequencies.append(frequency)

    return np.array(rows, dtype=float), np.array(frequencies, dtype=float)


def fit_log_odds(design: np.ndarray, frequencies: np.ndarray) -> np.ndarray:
    """
    Least-squares fit of trigger log-odds against the features.

    Fitting log-odds rather than the probability keeps predictions inside (0, 1)
    once passed through a logistic, so no clamp is needed to stop the model
    quoting a negative or an above-certain probability.
    """
    log_odds = np.log(frequencies / (1.0 - frequencies))
    coefficients, *_ = np.linalg.lstsq(design, log_odds, rcond=None)
    return coefficients


def build_payload(coefficients: np.ndarray, seed: int, observations: int) -> dict:
    payload = {
        "schemaVersion": SUPPORTED_SCHEMA_VERSION,
        "modelVersion": MODEL_VERSION,
        "provider": "baseline",
        "createdAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "features": list(FEATURES),
        # Rounded so the artifact is stable across platforms whose last bits of
        # floating-point noise differ; twelve digits is far beyond the precision
        # the fit itself carries.
        "coefficients": [round(float(value), 12) for value in coefficients],
        "regionRisk": dict(sorted(REGION_DAILY_RAINFALL_MM.items())),
        # Applied to a region the model has never seen: the mean of the known
        # regions, so an unknown region is priced as typical rather than as free
        # or as the worst case.
        "defaultRegionRisk": round(
            sum(REGION_DAILY_RAINFALL_MM.values()) / len(REGION_DAILY_RAINFALL_MM), 12
        ),
        "premiumLoading": PREMIUM_LOADING,
        "training": {
            "kind": "synthetic",
            "transitional": True,
            "note": (
                "Seeded gamma-distributed daily rainfall, not observed climate. "
                "Replaced by the Stage 08 data pipeline."
            ),
            "seed": seed,
            "yearsOfHistory": YEARS_OF_HISTORY,
            "observations": observations,
            "durationDaysGrid": list(DURATION_DAYS_GRID),
            "thresholdMmGrid": list(THRESHOLD_MM_GRID),
        },
    }
    payload["checksum"] = compute_checksum(payload)
    return payload


def _preserve_created_at(payload: dict, output: Path) -> dict:
    """
    Keeps the existing timestamp when nothing else changed.

    The artifact is committed, and CI rebuilds it to prove the file matches the
    script that claims to produce it — the same drift gate the contracts use for
    their ABIs. A fresh timestamp on every run would make that check fail
    constantly and teach everyone to ignore it, so a rebuild that changes
    nothing substantive stays byte-identical.
    """
    if not output.is_file():
        return payload

    try:
        existing = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return payload

    ignored = ("createdAt", "checksum")
    rebuilt = {k: v for k, v in payload.items() if k not in ignored}
    on_disk = {k: v for k, v in existing.items() if k not in ignored}
    if rebuilt != on_disk or "createdAt" not in existing:
        return payload

    payload["createdAt"] = existing["createdAt"]
    payload["checksum"] = compute_checksum(payload)
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args()

    history = generate_rainfall_history(args.seed)
    design, frequencies = measure_trigger_frequencies(history)
    coefficients = fit_log_odds(design, frequencies)
    payload = build_payload(coefficients, args.seed, len(frequencies))

    payload = _preserve_created_at(payload, args.output)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    # newline="\n" explicitly: write_text() translates to CRLF on Windows, and
    # the gate compares this file byte for byte against a fresh rebuild. A
    # checkout on one platform and a rebuild on another would then differ with
    # no semantic change at all. `.gitattributes` pins the checkout side.
    with args.output.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")

    print(f"Model version:  {payload['modelVersion']}")
    print(f"Observations:   {payload['training']['observations']}")
    print("Coefficients:")
    for name, value in zip(FEATURES, payload["coefficients"], strict=True):
        print(f"  {name:<20} {value: .6f}")
    print(f"Checksum:       {payload['checksum']}")
    print(f"Written to:     {args.output}")


if __name__ == "__main__":
    main()
