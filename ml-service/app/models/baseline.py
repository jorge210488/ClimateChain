"""
Evaluation of the baseline pricing model.

Deliberately free of any numerical library: the artifact holds coefficients and
evaluating them is arithmetic. Requiring a training stack at runtime would make
the serving image large and its dependency surface wide for no benefit, and the
training pipeline can change how the coefficients are produced without touching
this.

Three things go into a trigger probability, and each is in the artifact:

- the linear log-odds model — threshold, window length, and a per-region
  effect;
- a seasonal offset, when the artifact carries one: twelve monthly log-odds
  offsets per region, weighted by the share of the coverage window that falls
  in each month, so a window starting in April and one starting in November
  are priced as the different risks they are;
- an evidence floor, when the artifact carries one: the probability is never
  below the lower confidence bound of the trigger frequency observed in
  training for any grid cell the quote dominates — same region, a window at
  least as long, a threshold at least as low. The true probability is monotone
  in both, so the bound holds for the quote as well as for the cell.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta

from app.core.domain import (
    MAX_DURATION_DAYS,
    MAX_SAFE_INTEGER,
    MIN_DURATION_DAYS,
)
from app.models.artifact import (
    PREMIUM_RATE_SCALE,
    ModelArtifact,
    ModelArtifactError,
)

# Bounds on the modelled trigger probability. The logistic cannot leave (0, 1)
# on its own, but a future artifact with a broken fit could sit at either
# extreme, and pricing a policy at zero or at full coverage should be a visible
# refusal rather than a plausible-looking quote.
MIN_TRIGGER_PROBABILITY = 1e-4
MAX_TRIGGER_PROBABILITY = 0.99

SEASON_FEATURE = "season_risk"


@dataclass(frozen=True)
class PricingInputs:
    """Risk parameters a quote is computed from."""

    region: str
    rainfall_threshold_mm: int
    duration_days: int
    # Required when the artifact carries a seasonal term; the date the window
    # starts decides which months it spans.
    start_date: date | None = None


@dataclass(frozen=True)
class RiskAssessment:
    """What the model concluded, kept separate from the money it implies."""

    trigger_probability: float
    region_risk: float
    region_known: bool
    # The linear model's own estimate, before the evidence floor. Equal to
    # `trigger_probability` unless the floor was what set the price.
    model_probability: float
    evidence_floor: float
    priced_from_evidence: bool


def month_weights(start: date, duration_days: int) -> tuple[float, ...]:
    """
    Share of a coverage window falling in each calendar month, January first.

    Counted in whole days from the start date, inclusive, so a thirty-day
    window starting on 20 March is one third March and two thirds April.
    """
    if duration_days < 1:
        raise ValueError("duration_days must be at least 1")
    counts = [0] * 12
    current = start
    remaining = duration_days
    while remaining > 0:
        next_month = (current.replace(day=1) + timedelta(days=32)).replace(day=1)
        in_month = min(remaining, (next_month - current).days)
        counts[current.month - 1] += in_month
        remaining -= in_month
        current = next_month
    return tuple(count / duration_days for count in counts)


def _logistic(value: float) -> float:
    # Split by sign to avoid overflowing exp() on large negative inputs, which
    # is reachable for a high threshold on a dry region.
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exponential = math.exp(value)
    return exponential / (1.0 + exponential)


def _season_value(
    artifact: ModelArtifact, region_key: str, inputs: PricingInputs
) -> float:
    """The seasonal term for this window, or zero when the model has none."""
    if SEASON_FEATURE not in artifact.features:
        return 0.0
    if inputs.start_date is None:
        raise ValueError(
            "This model prices by season and needs the coverage start date"
        )
    offsets = artifact.season_risk.get(region_key)
    if offsets is None:
        # An unknown region has no seasonality the model can vouch for.
        return 0.0
    weights = month_weights(inputs.start_date, inputs.duration_days)
    return sum(weight * offset for weight, offset in zip(weights, offsets, strict=True))


def evidence_floor(
    artifact: ModelArtifact, region_key: str, duration_days: int, threshold_mm: int
) -> float:
    """
    The largest lower bound among the training cells this quote dominates.

    A quote dominates a cell when its window is at least as long and its
    threshold at least as low; the trigger is then at least as likely as in
    the cell, so the cell's bound is a bound for the quote too.
    """
    return max(
        (
            bound
            for cell_duration, cell_threshold, bound in artifact.evidence_floor.get(
                region_key, ()
            )
            if cell_duration <= duration_days and cell_threshold >= threshold_mm
        ),
        default=0.0,
    )


def assess_risk(artifact: ModelArtifact, inputs: PricingInputs) -> RiskAssessment:
    """
    Estimates how likely the policy is to pay out.

    The model is fitted on log-odds, so the linear combination is mapped back
    through a logistic, then held up against the evidence floor. Feature order
    follows the artifact rather than a literal here, so a future artifact that
    reorders or extends them fails loudly at load time instead of quietly
    mispricing.
    """
    normalized_region = inputs.region.strip().lower()
    region_known = normalized_region in artifact.region_risk
    region_risk = artifact.region_risk.get(
        normalized_region, artifact.default_region_risk
    )

    values = {
        "intercept": 1.0,
        "log_threshold_mm": math.log(inputs.rainfall_threshold_mm),
        "log_duration_days": math.log(inputs.duration_days),
        "region_risk": region_risk,
        SEASON_FEATURE: _season_value(artifact, normalized_region, inputs),
    }

    missing = [name for name in artifact.features if name not in values]
    if missing:
        raise ValueError(
            f"Model artifact requires features this service cannot compute: "
            f"{', '.join(missing)}"
        )

    log_odds = sum(
        coefficient * values[name]
        for name, coefficient in zip(
            artifact.features, artifact.coefficients, strict=True
        )
    )

    model_probability = min(
        max(_logistic(log_odds), MIN_TRIGGER_PROBABILITY), MAX_TRIGGER_PROBABILITY
    )
    floor = evidence_floor(
        artifact, normalized_region, inputs.duration_days, inputs.rainfall_threshold_mm
    )
    probability = min(max(model_probability, floor), MAX_TRIGGER_PROBABILITY)

    return RiskAssessment(
        trigger_probability=probability,
        region_risk=region_risk,
        region_known=region_known,
        model_probability=model_probability,
        evidence_floor=floor,
        priced_from_evidence=probability > model_probability,
    )


def assert_arithmetic_is_stable(artifact: ModelArtifact) -> None:
    """
    Proves the model can be evaluated across the whole accepted input range.

    Finite coefficients are not enough. Each term is a coefficient times a
    feature value, so a large-but-finite coefficient can overflow once
    multiplied, and a sum of `+inf` and `-inf` is `NaN` — which survives the
    logistic, survives the clamp, and only fails when the premium is rounded to
    an integer. Readiness would have reported a ready model that returns 500 on
    the first quote.

    Rather than capping coefficients at an arbitrary magnitude, this evaluates
    the real arithmetic at the extremes of what the API accepts. A model that
    stays finite at the corners stays finite inside them, because every feature
    is monotonic in its input and the seasonal term is bounded by its largest
    offset.

    :raises ModelArtifactError: when any term, log-odds, probability, or scaled
        rate is not finite.
    """
    # The extremes the request schema permits, plus every risk this model knows.
    thresholds = (1, MAX_SAFE_INTEGER)
    durations = (MIN_DURATION_DAYS, MAX_DURATION_DAYS)
    risks = (*artifact.region_risk.values(), artifact.default_region_risk)
    largest_offset = max(
        (
            abs(offset)
            for offsets in artifact.season_risk.values()
            for offset in offsets
        ),
        default=0.0,
    )
    seasons = (-largest_offset, 0.0, largest_offset)

    for threshold in thresholds:
        for duration in durations:
            for risk in risks:
                for season in seasons:
                    values = {
                        "intercept": 1.0,
                        "log_threshold_mm": math.log(threshold),
                        "log_duration_days": math.log(duration),
                        "region_risk": risk,
                        SEASON_FEATURE: season,
                    }

                    log_odds = 0.0
                    for name, coefficient in zip(
                        artifact.features, artifact.coefficients, strict=True
                    ):
                        term = coefficient * values[name]
                        if not math.isfinite(term):
                            raise ModelArtifactError(
                                f"Model artifact at {artifact.source_path} "
                                f"overflows: feature '{name}' with coefficient "
                                f"{coefficient} is not finite at "
                                f"threshold={threshold}, duration={duration}, "
                                f"risk={risk}, season={season}."
                            )
                        log_odds += term

                    if not math.isfinite(log_odds):
                        raise ModelArtifactError(
                            f"Model artifact at {artifact.source_path} produces "
                            f"non-finite log-odds at threshold={threshold}, "
                            f"duration={duration}, risk={risk}. Terms of opposing "
                            f"infinite sign cancel to NaN, which reaches the "
                            f"premium as a rounding failure rather than a visible "
                            f"error."
                        )

                    probability = _logistic(log_odds)
                    if not math.isfinite(probability):
                        raise ModelArtifactError(
                            f"Model artifact at {artifact.source_path} produces a "
                            f"non-finite probability at threshold={threshold}, "
                            f"duration={duration}, risk={risk}."
                        )

                    scaled = (
                        probability
                        * (1.0 + artifact.premium_loading)
                        * PREMIUM_RATE_SCALE
                    )
                    if not math.isfinite(scaled):
                        raise ModelArtifactError(
                            f"Model artifact at {artifact.source_path} produces a "
                            f"non-finite premium rate at threshold={threshold}, "
                            f"duration={duration}, risk={risk}."
                        )
