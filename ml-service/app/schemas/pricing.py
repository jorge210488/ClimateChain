"""
Request and response schemas for `/predict`.

These mirror the backend's `QuoteRequestDto` and `QuoteResponseDto`, which
Stage 05 already published and Stage 09 will call this service through. The
field names are the backend's, not new ones: a translation layer between two
services that agree on the meaning of every field would be pure overhead, and
the place a mismatch would surface is production.

`tests/test_backend_contract.py` checks these against the committed OpenAPI
document rather than against a copy of it kept here.
"""

from __future__ import annotations

import re
from datetime import date

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.domain import (
    MAX_DURATION_DAYS,
    MAX_REGION_CODE_BYTES,
    MAX_SAFE_INTEGER,
    MIN_DURATION_DAYS,
)
from app.core.money import POSITIVE_ETH_AMOUNT_PATTERN

# A calendar date and nothing else. Shape only; the calendar itself is checked
# by parsing, because a regex cannot know that February has no thirtieth.
CALENDAR_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class QuoteRequest(BaseModel):
    """Inputs required to price coverage."""

    # Accept the backend camelCase over the wire while keeping snake_case in
    # Python; populate_by_name lets tests construct either way. extra="forbid"
    # so a field the backend adds later surfaces as an error rather than being
    # silently dropped from the price.
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    region: str = Field(
        ...,
        description=(
            "Region identifier. Bounded by the same byte budget as the on-chain "
            "region code so a quoted region is always insurable."
        ),
        examples=["Valencia"],
    )
    start_date: date = Field(..., alias="startDate")
    end_date: date = Field(..., alias="endDate")
    coverage_eth: str = Field(..., alias="coverageEth", examples=["1.0"])
    rainfall_threshold_mm: int = Field(
        ...,
        alias="rainfallThresholdMm",
        ge=1,
        # Bounded above by what JavaScript represents exactly. Python would
        # carry a larger integer happily, but the backend rejects it — and a
        # threshold that changes value in transit is corrupted, not large.
        le=MAX_SAFE_INTEGER,
        examples=[50],
    )

    @field_validator("start_date", "end_date", mode="before")
    @classmethod
    def _is_a_calendar_date(cls, value: object) -> object:
        # Runs before pydantic converts, because pydantic accepts more than the
        # contract does: `2026-04-01T00:00:00Z` parses to a date here and is
        # refused by the backend. Narrowing the input first is what keeps one
        # spelling per date across both services.
        if isinstance(value, str) and not CALENDAR_DATE_PATTERN.match(value):
            raise ValueError(
                "dates must be calendar dates in YYYY-MM-DD form, without a "
                "time component"
            )
        return value

    @field_validator("region")
    @classmethod
    def _region_fits_on_chain(cls, value: str) -> str:
        if not value.strip():
            raise ValueError(
                "region must contain at least one non-whitespace character"
            )

        # Measured on the value as sent, because that is what gets encoded into
        # the bytes32 region code. Measuring a trimmed copy would accept a
        # padded name the chain cannot carry.
        encoded = len(value.encode("utf-8"))
        if encoded > MAX_REGION_CODE_BYTES:
            # Bytes, not characters: the limit is a bytes32 slot, so an accented
            # name costs more than its length suggests.
            raise ValueError(
                f"region is {encoded} UTF-8 bytes, above the on-chain limit of "
                f"{MAX_REGION_CODE_BYTES}"
            )

        # Returned unchanged. Whitespace is not noise here: the backend encodes
        # the region exactly as given, so a trimmed echo would name a different
        # region than the policy would carry. Normalisation happens only where
        # risk is looked up.
        return value

    @field_validator("coverage_eth")
    @classmethod
    def _coverage_is_an_eth_amount(cls, value: str) -> str:
        # One pattern, shared with the backend, so acceptance is identical in
        # both directions: zero and every spelling of it are refused by the
        # pattern itself, and leading zeros are allowed because the backend
        # allows them.
        if not POSITIVE_ETH_AMOUNT_PATTERN.match(value):
            raise ValueError(
                "coverageEth must be a positive decimal with at most "
                "30 integer digits and 18 fractional digits"
            )
        return value

    @model_validator(mode="after")
    def _window_is_insurable(self) -> QuoteRequest:
        if self.end_date < self.start_date:
            raise ValueError("endDate must be on or after startDate")

        duration_days = (self.end_date - self.start_date).days + 1
        if duration_days < MIN_DURATION_DAYS:
            raise ValueError(
                f"coverage window must span at least {MIN_DURATION_DAYS} day"
            )
        if duration_days > MAX_DURATION_DAYS:
            # Rejected here rather than quoted, because the provider caps policy
            # duration: a longer window could be priced but never created.
            raise ValueError(
                f"coverage window spans {duration_days} days, above the on-chain "
                f"maximum of {MAX_DURATION_DAYS}"
            )
        return self


class QuoteResponse(BaseModel):
    """
    A premium quote.

    Serialized with the backend's field names so `QuoteResponseDto` can be
    populated without remapping. `premiumWei` is the authoritative amount;
    `premiumEth` is the same value rendered for humans and round-trips exactly.
    """

    model_config = ConfigDict(populate_by_name=True)

    region: str
    premium_eth: str = Field(serialization_alias="premiumEth")
    premium_wei: str = Field(serialization_alias="premiumWei")
    currency: str = "ETH"
    start_date: date = Field(serialization_alias="startDate")
    end_date: date = Field(serialization_alias="endDate")
    model_version: str = Field(serialization_alias="modelVersion")

    # Pricing detail beyond the backend contract. Additive, so it cannot break
    # a consumer that ignores it, and it is what makes a quote explainable
    # instead of a number with no provenance.
    trigger_probability: float = Field(serialization_alias="triggerProbability")
    duration_days: int = Field(serialization_alias="durationDays")
    region_known: bool = Field(serialization_alias="regionKnown")
    floored_to_minimum: bool = Field(serialization_alias="flooredToMinimum")
