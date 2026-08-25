"""
Evaluation of the baseline pricing model.

Deliberately free of any numerical library: the artifact holds coefficients and
evaluating them is arithmetic. Requiring a training stack at runtime would make
the serving image large and its dependency surface wide for no benefit, and
Stage 08 can change how the coefficients are produced without touching this.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.models.artifact import ModelArtifact

# Bounds on the modelled trigger probability. The logistic cannot leave (0, 1)
# on its own, but a future artifact with a broken fit could sit at either
# extreme, and pricing a policy at zero or at full coverage should be a visible
# refusal rather than a plausible-looking quote.
MIN_TRIGGER_PROBABILITY = 1e-4
MAX_TRIGGER_PROBABILITY = 0.99


@dataclass(frozen=True)
class PricingInputs:
    """Risk parameters a quote is computed from."""

    region: str
    rainfall_threshold_mm: int
    duration_days: int


@dataclass(frozen=True)
class RiskAssessment:
    """What the model concluded, kept separate from the money it implies."""

    trigger_probability: float
    region_risk: float
    region_known: bool


def _logistic(value: float) -> float:
    # Split by sign to avoid overflowing exp() on large negative inputs, which
    # is reachable for a high threshold on a dry region.
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exponential = math.exp(value)
    return exponential / (1.0 + exponential)


def assess_risk(artifact: ModelArtifact, inputs: PricingInputs) -> RiskAssessment:
    """
    Estimates how likely the policy is to pay out.

    The model is fitted on log-odds, so the linear combination is mapped back
    through a logistic. Feature order follows the artifact rather than a literal
    here, so a future artifact that reorders or extends them fails loudly at
    load time instead of quietly mispricing.
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

    probability = _logistic(log_odds)
    probability = min(
        max(probability, MIN_TRIGGER_PROBABILITY), MAX_TRIGGER_PROBABILITY
    )

    return RiskAssessment(
        trigger_probability=probability,
        region_risk=region_risk,
        region_known=region_known,
    )
