"""
Trains the pricing model from the committed rainfall history and writes the
artifact the Stage 07 runtime loads.

This replaces the Stage 07 build script, which fitted the same model family to
synthetic rainfall so that the loading lifecycle could be exercised before real
data existed. The artifact contract is unchanged in shape — the runtime reads
this artifact with the same loader — and what changes is the evidence behind
the coefficients and what the artifact carries about it.

The model, in three parts, each of which the data demanded:

1. A linear fit of trigger log-odds on log threshold and log window length,
   with one fitted effect per region (`regionRisk`, in log-odds, driest region
   at zero, unit coefficient). One "wetness" feature could not hold a desert
   and a tropical city on one line.
2. A seasonal offset per region and calendar month (`seasonRisk`), applied in
   proportion to the share of the coverage window that falls in each month.
   Sevilla in April and Sevilla in November are not the same risk, and a
   product sold by dates that priced them the same would be bought only for
   the wet months.
3. An evidence floor per region and grid cell (`evidenceFloor`): the one-sided
   95% lower confidence bound of the trigger frequency observed on the
   training years. A quote is never priced below the bound of any cell it
   dominates — same region, a window at least as long, a threshold at least
   as low — because the true probability is monotone in both. This is what
   holds the long-window, moderate-threshold cells the linear form cannot
   reach: a 30 mm day in Valencia within any given year is close to certain,
   and the record says so with far more confidence than a fitted slope.

Reproducible by construction: the dataset is committed and checksummed, the
split is by calendar date, every fit is a deterministic least-squares solve,
and the artifact records the hash of the configuration and of this script.
Running it twice yields byte-identical output; the gate depends on that.

Evaluation is time-based: fitted on the first twenty-four years of the
dataset, scored on the last six it never saw, using the runtime's own
evaluator so the metrics describe the deployed code path. Every archived
artifact is scored on the same holdout. Scores are given in aggregate, per
region, per duration, per start month, and per grid cell — with a per-cell
criterion that accounts for sample size, so a cell with six windows is judged
by what six windows can prove rather than ignored.

Two modes. Without flags it *releases*: stages the artifact and its metrics,
validates the staged artifact as the runtime would, and moves both into place.
With `--check` it writes nothing and fails if what it would produce differs
from the committed files — which is what the gate runs.

Usage:
    python scripts/train_rainfall_model.py [--dataset PATH] [--output PATH]
    python scripts/train_rainfall_model.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import numpy as np

MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

from app.data.rainfall import (  # noqa: E402
    RainfallDataset,
    date_at,
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
from app.models.baseline import (  # noqa: E402
    PricingInputs,
    assess_risk,
    month_weights,
)

MODEL_VERSION = "baseline-premium-v3"
MODEL_FORM = (
    "log-odds linear in log(threshold), log(duration); one effect per region; "
    "monthly seasonal offsets per region; evidence floor per region and grid cell"
)
ARTIFACTS_DIR = MODULE_ROOT / "app/models/artifacts"
ARCHIVE_DIR = ARTIFACTS_DIR / "archive"
DEFAULT_DATASET = MODULE_ROOT / "data/rainfall-history.json"
DEFAULT_OUTPUT = ARTIFACTS_DIR / f"{MODEL_VERSION}.json"
DEFAULT_METRICS = ARTIFACTS_DIR / f"{MODEL_VERSION}.metrics.json"

# The grid trigger frequency is measured over. Identical to Stage 07's so every
# artifact is estimated on the same design and the comparison is fair.
# Widening it towards 1-day windows and 1 mm thresholds was measured and
# rejected: it degraded calibration on the range most policies are written in.
DURATION_DAYS_GRID = (7, 14, 30, 60, 90, 180, 365)
THRESHOLD_MM_GRID = (10, 20, 30, 50, 80, 120, 200, 300)

# Time-based split on whole years: the most recent complete years are held
# out, because they are the period a deployed model would actually be pricing
# into. Derived from the dataset so a refreshed dataset moves the split.
HOLDOUT_YEARS = 6

# Margin over expected loss. A commercial choice carried over unchanged from
# Stage 07; nothing in the data can decide it.
PREMIUM_LOADING = 0.35

# Log-odds are undefined at exactly 0 or 1; frequencies are clamped inside.
FREQUENCY_FLOOR = 0.002
FREQUENCY_CEILING = 0.98

# Confidence for the evidence floor and for the per-cell acceptance criterion.
# One-sided: the question is only ever whether the price is too low.
CELL_CONFIDENCE = 0.95

FEATURES = (
    "intercept",
    "log_threshold_mm",
    "log_duration_days",
    "region_risk",
    "season_risk",
)


@dataclass(frozen=True)
class Split:
    """Series positions for one part of the time split."""

    label: str
    start_index: int
    end_index: int  # exclusive


def make_splits(dataset: RainfallDataset) -> tuple[Split, Split]:
    test_start = date(dataset.end.year - HOLDOUT_YEARS + 1, 1, 1)
    train_end = test_start - timedelta(days=1)
    if not (dataset.start < train_end < test_start <= dataset.end):
        raise SystemExit(
            f"A {HOLDOUT_YEARS}-year holdout does not fit inside the dataset range "
            f"{dataset.start}..{dataset.end}"
        )
    train = Split("train", 0, day_index(dataset, train_end) + 1)
    test = Split("test", day_index(dataset, test_start), dataset.days)
    return train, test


def windows(
    series: tuple[float, ...], split: Split, duration: int
) -> tuple[np.ndarray, np.ndarray]:
    """
    Non-overlapping windows tiled from the start of the split.

    Returns each window's start position in the series and its maximum daily
    rainfall. Non-overlapping so windows share no days; overlapping ones would
    count the same wet day many times and understate the variance of every
    estimate.
    """
    values = np.asarray(series[split.start_index : split.end_index], dtype=float)
    usable = (len(values) // duration) * duration
    if usable == 0:
        return np.zeros(0, dtype=int), np.zeros(0, dtype=float)
    maxima = values[:usable].reshape(-1, duration).max(axis=1)
    starts = split.start_index + np.arange(len(maxima)) * duration
    return starts, maxima


def window_outcomes(
    series: tuple[float, ...], split: Split, duration: int, threshold: int
) -> np.ndarray:
    """One boolean per non-overlapping window: did rainfall reach the threshold?"""
    _, maxima = windows(series, split, duration)
    return maxima >= threshold


def region_means(dataset: RainfallDataset, split: Split) -> dict[str, float]:
    """
    Mean daily rainfall per region on the training period.

    Recorded in the artifact for the auditor, not used by the fit: it is the
    plain-language description of each region's climate that the fitted
    effect is standing in for.
    """
    return {
        key: round(
            float(np.mean(series.mm_per_day[split.start_index : split.end_index])), 6
        )
        for key, series in dataset.regions.items()
    }


def _clamped_log_odds(frequency: float) -> float:
    frequency = min(max(frequency, FREQUENCY_FLOOR), FREQUENCY_CEILING)
    return math.log(frequency / (1.0 - frequency))


def fit(dataset: RainfallDataset, train: Split) -> tuple[np.ndarray, dict[str, float]]:
    """
    Least-squares fit of trigger log-odds on the training grid.

    Returns the coefficients for `FEATURES` and the per-region effects the
    artifact carries as `regionRisk`. The effects are shifted so the smallest
    is zero — the loader requires them non-negative — and the shift moves into
    the intercept, so the fitted surface is unchanged. The seasonal
    coefficient is one: the offsets are fitted separately and carried verbatim.

    Fitted on the training split only: the holdout must not shape the
    quantities it is then scored on.
    """
    keys = list(dataset.regions)
    rows: list[list[float]] = []
    log_odds: list[float] = []

    for position, key in enumerate(keys):
        series = dataset.regions[key]
        indicator = [1.0 if index == position else 0.0 for index in range(len(keys))]
        for duration in DURATION_DAYS_GRID:
            for threshold in THRESHOLD_MM_GRID:
                outcomes = window_outcomes(
                    series.mm_per_day, train, duration, threshold
                )
                if len(outcomes) == 0:
                    continue
                rows.append([math.log(threshold), math.log(duration), *indicator])
                log_odds.append(_clamped_log_odds(float(outcomes.mean())))

    design = np.asarray(rows, dtype=float)
    target = np.asarray(log_odds, dtype=float)
    beta, *_ = np.linalg.lstsq(design, target, rcond=None)

    effects = beta[2:]
    shift = float(effects.min())
    risks = {
        key: round(float(effect - shift), 6)
        for key, effect in zip(keys, effects, strict=True)
    }
    coefficients = np.asarray([shift, beta[0], beta[1], 1.0, 1.0], dtype=float)
    return coefficients, risks


def _base_log_odds(
    coefficients: np.ndarray, risks: dict[str, float], key: str, d: int, th: int
) -> float:
    return float(
        coefficients[0]
        + coefficients[1] * math.log(th)
        + coefficients[2] * math.log(d)
        + coefficients[3] * risks[key]
    )


def fit_season(
    dataset: RainfallDataset,
    train: Split,
    coefficients: np.ndarray,
    risks: dict[str, float],
) -> dict[str, list[float]]:
    """
    Monthly log-odds offsets per region, fitted on the residuals of the base.

    Windows are grouped by region, duration, threshold, and the month they
    start in; each group's residual log-odds is regressed on the share of its
    windows' days falling in each calendar month, weighted by the group's size.
    A soft constraint centres every region's twelve offsets at zero so the
    region effect keeps its meaning and a 365-day window — which touches every
    month about equally — sees no seasonal term at all.
    """
    keys = list(dataset.regions)
    rows: list[np.ndarray] = []
    target: list[float] = []
    weights: list[float] = []

    for position, key in enumerate(keys):
        series = dataset.regions[key]
        for duration in DURATION_DAYS_GRID:
            starts, maxima = windows(series.mm_per_day, train, duration)
            if len(starts) == 0:
                continue
            shares = np.asarray(
                [month_weights(date_at(dataset, int(s)), duration) for s in starts]
            )
            start_months = np.asarray([date_at(dataset, int(s)).month for s in starts])
            for threshold in THRESHOLD_MM_GRID:
                outcomes = maxima >= threshold
                base = _base_log_odds(coefficients, risks, key, duration, threshold)
                for month in range(1, 13):
                    members = start_months == month
                    if not members.any():
                        continue
                    row = np.zeros(len(keys) * 12)
                    row[position * 12 : (position + 1) * 12] = shares[members].mean(
                        axis=0
                    )
                    rows.append(row)
                    target.append(
                        _clamped_log_odds(float(outcomes[members].mean())) - base
                    )
                    weights.append(math.sqrt(float(members.sum())))

    design = np.asarray(rows) * np.asarray(weights)[:, None]
    response = np.asarray(target) * np.asarray(weights)
    centring = np.zeros((len(keys), len(keys) * 12))
    for position in range(len(keys)):
        centring[position, position * 12 : (position + 1) * 12] = 100.0
    offsets, *_ = np.linalg.lstsq(
        np.vstack([design, centring]),
        np.concatenate([response, np.zeros(len(keys))]),
        rcond=None,
    )
    offsets = offsets.reshape(len(keys), 12)
    return {
        key: [round(float(value), 6) for value in offsets[position]]
        for position, key in enumerate(keys)
    }


def _betacf(a: float, b: float, x: float) -> float:
    """Continued fraction for the incomplete beta function (Lentz's method)."""
    max_iterations, epsilon, tiny = 300, 3e-14, 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    d = tiny if abs(d) < tiny else d
    d = 1.0 / d
    h = d
    for m in range(1, max_iterations + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        d = tiny if abs(d) < tiny else d
        c = 1.0 + aa / c
        c = tiny if abs(c) < tiny else c
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        d = tiny if abs(d) < tiny else d
        c = 1.0 + aa / c
        c = tiny if abs(c) < tiny else c
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < epsilon:
            break
    return h


def beta_cdf(x: float, a: float, b: float) -> float:
    """Regularised incomplete beta function I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    log_front = (
        math.lgamma(a + b)
        - math.lgamma(a)
        - math.lgamma(b)
        + a * math.log(x)
        + b * math.log(1.0 - x)
    )
    if x < (a + 1.0) / (a + b + 2.0):
        return math.exp(log_front) * _betacf(a, b, x) / a
    return 1.0 - math.exp(log_front) * _betacf(b, a, 1.0 - x) / b


def binomial_lower_bound(successes: int, trials: int, confidence: float) -> float:
    """
    One-sided Clopper-Pearson lower bound for a binomial proportion.

    The largest p at which observing at least `successes` of `trials` would
    still be as unlikely as `1 - confidence`. Exact, so it is honest at six
    trials and at a thousand; six of six gives 0.607 at 95%, not 1.0.
    """
    if trials <= 0 or successes <= 0:
        return 0.0
    if successes > trials:
        raise ValueError("more successes than trials")
    tail = 1.0 - confidence
    low, high = 0.0, 1.0
    for _ in range(100):
        mid = (low + high) / 2.0
        # P(X >= k | p) is the regularised incomplete beta I_p(k, n - k + 1).
        if beta_cdf(mid, successes, trials - successes + 1) < tail:
            low = mid
        else:
            high = mid
    return low


def binomial_upper_quantile(trials: int, probability: float, confidence: float) -> int:
    """
    Smallest k such that P(X <= k) >= confidence for X ~ Binomial(trials, p).

    Used for the chance allowance of the per-cell criterion: a perfectly
    calibrated model still fails a one-sided 95% test in about 5% of cells, so
    the number of flagged cells is judged against what chance alone produces.
    """
    for k in range(trials + 1):
        # P(X <= k) = 1 - I_p(k + 1, n - k)
        if k == trials or 1.0 - beta_cdf(probability, k + 1, trials - k) >= confidence:
            return k
    return trials


def evidence_floor(dataset: RainfallDataset, train: Split) -> dict[str, list[list]]:
    """
    Lower confidence bounds of the training-period trigger frequency per cell.

    Only cells whose bound is above zero are recorded; a cell that never
    triggered proves nothing a floor could use. The runtime applies the
    largest bound among the cells a quote dominates.
    """
    floors: dict[str, list[list]] = {}
    for key, series in dataset.regions.items():
        cells: list[list] = []
        for duration in DURATION_DAYS_GRID:
            outcomes_by_threshold = {
                threshold: window_outcomes(
                    series.mm_per_day, train, duration, threshold
                )
                for threshold in THRESHOLD_MM_GRID
            }
            for threshold, outcomes in outcomes_by_threshold.items():
                if len(outcomes) == 0:
                    continue
                bound = binomial_lower_bound(
                    int(outcomes.sum()), len(outcomes), CELL_CONFIDENCE
                )
                if bound > 0.0:
                    cells.append([duration, threshold, round(bound, 6)])
        if cells:
            floors[key] = cells
    return floors


def in_memory_artifact(
    coefficients: tuple[float, ...],
    risks: dict[str, float],
    season: dict[str, list[float]],
    floors: dict[str, list[list]],
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
        season_risk={key: tuple(values) for key, values in season.items()},
        evidence_floor={
            key: tuple((int(d), int(th), float(p)) for d, th, p in cells)
            for key, cells in floors.items()
        },
    )


def _score(predicted: list[float], observed: list[float]) -> dict:
    """Proper scores plus the rates that make calibration and solvency visible."""
    p = np.asarray(predicted, dtype=float)
    y = np.asarray(observed, dtype=float)
    losses = -(y * np.log(p) + (1 - y) * np.log(1 - p))
    return {
        "windows": len(p),
        "logLoss": round(float(np.mean(losses)), 6),
        "brier": round(float(np.mean((p - y) ** 2)), 6),
        "observedTriggerRate": round(float(np.mean(y)), 6),
        "predictedTriggerRate": round(float(np.mean(p)), 6),
        # What the pool would have charged, as a rate of coverage, against
        # what it would have paid. Above observed means the book was solvent.
        "loadedPremiumRate": round(float(np.mean(p)) * (1.0 + PREMIUM_LOADING), 6),
    }


def evaluate(artifact: ModelArtifact, dataset: RainfallDataset, test: Split) -> dict:
    """
    Scores a model on the holdout with the runtime's own `assess_risk`.

    Every holdout window is priced as the service would price it — including
    its start date — and scored with log-loss and Brier, both proper, so a
    model cannot improve them by hedging. Rates are reported in aggregate,
    per region, per duration, and per start month, and every grid cell is
    judged with a criterion that accounts for its sample: the cell is
    under-priced with confidence when the loaded premium is below the lower
    confidence bound of its observed frequency. Six windows can prove a
    frequency is above 0.6; they cannot prove it is 1.0, and the criterion
    says exactly that.
    """
    all_predicted: list[float] = []
    all_observed: list[float] = []
    by_region: dict[str, dict] = {}
    by_duration: dict[int, tuple[list, list]] = defaultdict(lambda: ([], []))
    by_month: dict[int, tuple[list, list]] = defaultdict(lambda: ([], []))
    cells: list[dict] = []
    evidence_priced = 0

    for key, series in dataset.regions.items():
        region_predicted: list[float] = []
        region_observed: list[float] = []
        for duration in DURATION_DAYS_GRID:
            starts, maxima = windows(series.mm_per_day, test, duration)
            if len(starts) == 0:
                continue
            start_dates = [date_at(dataset, int(s)) for s in starts]
            for threshold in THRESHOLD_MM_GRID:
                predicted: list[float] = []
                observed: list[float] = []
                for start, maximum in zip(start_dates, maxima, strict=True):
                    assessment = assess_risk(
                        artifact,
                        PricingInputs(
                            region=key,
                            rainfall_threshold_mm=threshold,
                            duration_days=duration,
                            start_date=start,
                        ),
                    )
                    predicted.append(assessment.trigger_probability)
                    observed.append(1.0 if maximum >= threshold else 0.0)
                    evidence_priced += assessment.priced_from_evidence
                    if duration <= 30:
                        by_month[start.month][0].append(assessment.trigger_probability)
                        by_month[start.month][1].append(observed[-1])
                triggers = int(sum(observed))
                frequency = triggers / len(observed)
                loaded = float(np.mean(predicted)) * (1.0 + PREMIUM_LOADING)
                lower = binomial_lower_bound(triggers, len(observed), CELL_CONFIDENCE)
                cells.append(
                    {
                        "region": key,
                        "durationDays": duration,
                        "thresholdMm": threshold,
                        "windows": len(observed),
                        "triggers": triggers,
                        "observedTriggerRate": round(frequency, 6),
                        "observedLowerBound": round(lower, 6),
                        "predictedTriggerRate": round(float(np.mean(predicted)), 6),
                        "loadedPremiumRate": round(loaded, 6),
                        "deficit": round(max(frequency - loaded, 0.0), 6),
                        "underpricedWithConfidence": loaded < lower,
                    }
                )
                region_predicted.extend(predicted)
                region_observed.extend(observed)
                by_duration[duration][0].extend(predicted)
                by_duration[duration][1].extend(observed)
        if region_predicted:
            by_region[key] = _score(region_predicted, region_observed)
            all_predicted.extend(region_predicted)
            all_observed.extend(region_observed)

    confident = [cell for cell in cells if cell["underpricedWithConfidence"]]
    # How many flags a calibrated model would raise by chance alone, at the
    # same confidence, with this many cells: the acceptance criterion is to
    # stay within it, not to reach zero, which no honest model can promise.
    chance_allowance = binomial_upper_quantile(
        len(cells), 1.0 - CELL_CONFIDENCE, CELL_CONFIDENCE
    )
    return {
        **_score(all_predicted, all_observed),
        "pricedFromEvidenceShare": round(evidence_priced / len(all_predicted), 6),
        "byRegion": by_region,
        "byDuration": {
            str(duration): _score(*by_duration[duration])
            for duration in DURATION_DAYS_GRID
        },
        "byStartMonth": {
            str(month): _score(*by_month[month]) for month in sorted(by_month)
        },
        "cells": {
            "total": len(cells),
            "confidence": CELL_CONFIDENCE,
            "underpriced": sum(1 for cell in cells if cell["deficit"] > 0),
            "underpricedWithConfidence": len(confident),
            "chanceAllowance": chance_allowance,
            "withinChanceAllowance": len(confident) <= chance_allowance,
            "underpricedWithConfidenceCells": sorted(
                confident,
                key=lambda cell: cell["observedLowerBound"] - cell["loadedPremiumRate"],
                reverse=True,
            ),
        },
    }


def previous_models(dataset: RainfallDataset, test: Split) -> list[dict]:
    """Scores every archived artifact on the same holdout, oldest first."""
    scored: list[dict] = []
    for path in sorted(ARCHIVE_DIR.glob("*.json")):
        try:
            previous = load_artifact(path)
        except ModelArtifactError as error:
            raise SystemExit(
                f"Archived artifact {path.name} is unreadable: {error}"
            ) from error
        metrics = evaluate(previous, dataset, test)
        scored.append(
            {
                "modelVersion": previous.model_version,
                "trainingKind": previous.training_kind,
                "checksum": previous.checksum,
                **metrics,
            }
        )
    return scored


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
        "modelForm": MODEL_FORM,
        "datasetVersion": dataset.dataset_version,
        "datasetChecksum": dataset.checksum,
        "holdoutYears": HOLDOUT_YEARS,
        "durationDaysGrid": list(DURATION_DAYS_GRID),
        "thresholdMmGrid": list(THRESHOLD_MM_GRID),
        "premiumLoading": PREMIUM_LOADING,
        "frequencyFloor": FREQUENCY_FLOOR,
        "frequencyCeiling": FREQUENCY_CEILING,
        "cellConfidence": CELL_CONFIDENCE,
        "features": list(FEATURES),
        "trainerSha256": source_fingerprint(Path(__file__).read_bytes()),
    }
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_payload(
    dataset: RainfallDataset,
    coefficients: np.ndarray,
    risks: dict[str, float],
    season: dict[str, list[float]],
    floors: dict[str, list[list]],
    means: dict[str, float],
    train: Split,
    test: Split,
    holdout: dict,
    previous: list[dict],
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
        "seasonRisk": dict(sorted(season.items())),
        "evidenceFloor": dict(sorted(floors.items())),
        "premiumLoading": PREMIUM_LOADING,
        "training": {
            "kind": "observed",
            "transitional": False,
            "note": (
                "Fitted to ERA5 daily precipitation for the listed regions; "
                "evaluated on the most recent complete years, which the fit never "
                "saw. regionRisk is the fitted per-region effect in log-odds with "
                "the driest region at zero; seasonRisk holds twelve monthly "
                "log-odds offsets per region, centred at zero, applied by the "
                "share of the coverage window in each month; evidenceFloor holds, "
                "per region, the one-sided lower confidence bound of the trigger "
                "frequency observed in training for each grid cell, and a quote "
                "is never priced below the bound of a cell it dominates. "
                "regionMeanMmPerDay describes the same regions in plain units."
            ),
            "modelForm": MODEL_FORM,
            "datasetVersion": dataset.dataset_version,
            "datasetChecksum": dataset.checksum,
            "source": dataset.source,
            "dateRange": {
                "start": dataset.start.isoformat(),
                "end": dataset.end.isoformat(),
            },
            "split": {
                "trainEnd": date_at(dataset, train.end_index - 1).isoformat(),
                "testStart": date_at(dataset, test.start_index).isoformat(),
                "trainDays": train.end_index - train.start_index,
                "testDays": test.end_index - test.start_index,
            },
            "durationDaysGrid": list(DURATION_DAYS_GRID),
            "thresholdMmGrid": list(THRESHOLD_MM_GRID),
            "cellConfidence": CELL_CONFIDENCE,
            "regionMeanMmPerDay": dict(sorted(means.items())),
            "configHash": config_hash(dataset),
            "metrics": {"holdout": holdout, "previousModels": previous},
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


def release(
    artifact_payload: dict, metrics_payload: dict, output: Path, metrics: Path
) -> None:
    """
    Publishes the artifact and its metrics as one unit, or neither.

    Both files are staged beside their destinations and flushed to disk; the
    staged artifact is then loaded exactly as the runtime would load it. Only
    after that do the staged files replace the committed ones, so an
    interrupted or invalid release cannot leave a truncated artifact the
    service would refuse, nor a new artifact beside stale metrics.
    """
    staged: list[tuple[Path, Path]] = []
    try:
        for path, rendered in (
            (output, render_json(artifact_payload)),
            (metrics, render_json(metrics_payload)),
        ):
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
            with temporary.open("wb") as handle:
                handle.write(rendered)
                handle.flush()
                os.fsync(handle.fileno())
            staged.append((temporary, path))

        # Validate the bytes on disk, not the dict: the file is what ships.
        load_artifact(staged[0][0])
        json.loads(staged[1][0].read_text(encoding="utf-8"))

        # Metrics first, then the artifact: if the second move never happens,
        # the artifact the runtime loads is still the old, valid one — and the
        # metrics are put back, so the pair on disk stays a pair. A power loss
        # between the two renames is the one case this cannot undo; the gate
        # catches it, because the metrics would no longer match the artifact.
        (artifact_tmp, artifact_path), (metrics_tmp, metrics_path) = staged
        previous_metrics = metrics_path.read_bytes() if metrics_path.is_file() else None
        os.replace(metrics_tmp, metrics_path)
        try:
            os.replace(artifact_tmp, artifact_path)
        except OSError:
            if previous_metrics is None:
                metrics_path.unlink(missing_ok=True)
            else:
                metrics_path.write_bytes(previous_metrics)
            raise
    finally:
        for temporary, _ in staged:
            if temporary.exists():
                temporary.unlink()


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
    means = region_means(dataset, train)
    coefficients, risks = fit(dataset, train)
    season = fit_season(dataset, train, coefficients, risks)
    floors = evidence_floor(dataset, train)

    candidate = in_memory_artifact(
        tuple(round(float(v), 12) for v in coefficients),
        risks,
        season,
        floors,
        round(sum(risks.values()) / len(risks), 6),
        MODEL_VERSION,
    )
    holdout = evaluate(candidate, dataset, test)
    previous = previous_models(dataset, test)

    payload = _preserve_created_at(
        build_payload(
            dataset,
            coefficients,
            risks,
            season,
            floors,
            means,
            train,
            test,
            holdout,
            previous,
        ),
        args.output,
    )
    metrics_payload = {
        "modelVersion": MODEL_VERSION,
        "datasetVersion": dataset.dataset_version,
        "split": payload["training"]["split"],
        "holdout": holdout,
        "previousModels": previous,
    }

    if args.check:
        check_against_committed(payload, metrics_payload, args.output, args.metrics)
        print(
            f"check OK: {args.output.name} and {args.metrics.name} match a fresh "
            f"run (checksum {payload['checksum'][:12]}...)"
        )
        return

    release(payload, metrics_payload, args.output, args.metrics)

    split = payload["training"]["split"]
    print(f"Model:        {MODEL_VERSION}")
    print(f"Dataset:      {dataset.dataset_version} ({dataset.checksum[:12]}...)")
    print(
        f"Train/test:   {dataset.start}..{split['trainEnd']} / "
        f"{split['testStart']}..{dataset.end}"
    )
    print("Coefficients:")
    for name, value in zip(FEATURES, payload["coefficients"], strict=True):
        print(f"  {name:<20} {value: .6f}")
    print("Region effect (log-odds, driest at 0), seasonal range, mean mm/day:")
    for key, value in payload["regionRisk"].items():
        amplitude = max(season[key]) - min(season[key])
        print(
            f"  {key:<14} {value:.3f}   ±{amplitude / 2:.2f}   {means[key]:.2f} mm/day"
        )
    print(
        f"Holdout:      logLoss={holdout['logLoss']:.4f} brier={holdout['brier']:.4f} "
        f"observed={holdout['observedTriggerRate']:.4f} "
        f"predicted={holdout['predictedTriggerRate']:.4f} "
        f"windows={holdout['windows']}"
    )
    cells = holdout["cells"]
    print(
        f"Cells:        {cells['underpricedWithConfidence']} of {cells['total']} "
        f"under-priced with {CELL_CONFIDENCE:.0%} confidence (chance alone allows "
        f"{cells['chanceAllowance']}); "
        f"{holdout['pricedFromEvidenceShare']:.1%} of windows priced from evidence"
    )
    for model in previous:
        print(
            f"Previous ({model['modelVersion']}, {model['trainingKind']}): "
            f"logLoss={model['logLoss']:.4f} brier={model['brier']:.4f} "
            f"confident under-priced cells="
            f"{model['cells']['underpricedWithConfidence']}"
        )
    print(f"Checksum:     {payload['checksum']}")
    print(f"Written:      {args.output}")


if __name__ == "__main__":
    main()
