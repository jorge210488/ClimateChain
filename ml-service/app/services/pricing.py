"""
Turns a risk assessment into a premium the chain will accept.

The split matters: the model estimates how likely a payout is, and this decides
what to charge for it. Keeping them apart means Stage 08 can replace the model
without relitigating the pricing floor, and the floor is the part that has to
agree with the contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from app.core.domain import minimum_premium_wei
from app.core.money import format_wei_to_eth, parse_eth_to_wei
from app.models.artifact import ModelArtifact
from app.models.baseline import PricingInputs, assess_risk


@dataclass(frozen=True)
class Quote:
    """A premium quote, in both representations the backend contract carries."""

    premium_wei: int
    premium_eth: str
    trigger_probability: float
    duration_days: int
    region_known: bool
    floored_to_minimum: bool
    model_version: str


def coverage_window_days(start: date, end: date) -> int:
    """
    Length of the coverage window in whole days, counting both endpoints.

    A policy covering a single day is one day, not zero. The contract derives
    its window the same way, and an off-by-one here would price a window the
    provider will not create.
    """
    return (end - start).days + 1


def quote_premium(
    artifact: ModelArtifact,
    region: str,
    coverage_eth: str,
    rainfall_threshold_mm: int,
    start_date: date,
    end_date: date,
) -> Quote:
    """
    Prices coverage as expected loss plus the artifact's loading.

    The result is floored at the provider's minimum premium ratio. Without that
    floor a low-risk quote would be arithmetically correct and commercially
    useless: the caller would take the number straight to `POST /policies` and
    receive `PremiumBelowMinimum`. A quote that cannot be acted on is a defect,
    not a cheap price.
    """
    coverage_wei = parse_eth_to_wei(coverage_eth)
    duration_days = coverage_window_days(start_date, end_date)

    assessment = assess_risk(
        artifact,
        PricingInputs(
            region=region,
            rainfall_threshold_mm=rainfall_threshold_mm,
            duration_days=duration_days,
        ),
    )

    # Integer arithmetic throughout. The probability is a float, so it is scaled
    # into an integer rate before touching the coverage amount; multiplying wei
    # by a float would lose precision at the bottom of the value.
    rate_scale = 10**12
    loaded_rate = assessment.trigger_probability * (1.0 + artifact.premium_loading)
    scaled_rate = round(loaded_rate * rate_scale)
    expected_premium_wei = (coverage_wei * scaled_rate) // rate_scale

    floor_wei = minimum_premium_wei(coverage_wei)
    premium_wei = max(expected_premium_wei, floor_wei)

    return Quote(
        premium_wei=premium_wei,
        premium_eth=format_wei_to_eth(premium_wei),
        trigger_probability=assessment.trigger_probability,
        duration_days=duration_days,
        region_known=assessment.region_known,
        floored_to_minimum=premium_wei > expected_premium_wei,
        model_version=artifact.model_version,
    )
