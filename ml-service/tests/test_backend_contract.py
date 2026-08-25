"""
Checks this service against artifacts the earlier stages published.

This is the integration evidence for Stage 07. Stage 09 wires the HTTP call, so
nothing here reaches the backend at runtime — but the contract it will call
through already exists, committed, and can be verified now. Discovering a
mismatch when the two are first wired together would mean rewriting one of them.

Two prior-stage artifacts are read directly, never copied:

- `docs/api/backend-openapi.json`, the published pricing contract (Stage 05).
- `backend/src/modules/policies/policy.constants.ts`, the domain mirror the
  backend validates against, which itself is verified against the deployed
  contracts at boot (Stage 06).
"""

from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

import pytest

from app.core import domain
from app.schemas.pricing import QuoteRequest, QuoteResponse

REPO_ROOT = Path(__file__).resolve().parents[2]
OPENAPI_PATH = REPO_ROOT / "docs/api/backend-openapi.json"
POLICY_CONSTANTS_PATH = REPO_ROOT / "backend/src/modules/policies/policy.constants.ts"


@pytest.fixture(scope="module")
def backend_schemas() -> dict:
    if not OPENAPI_PATH.is_file():
        pytest.fail(
            f"The backend's published contract is missing at {OPENAPI_PATH}. "
            f"Regenerate it with `npm run api:export` in backend/."
        )
    document = json.loads(OPENAPI_PATH.read_text(encoding="utf-8"))
    return document["components"]["schemas"]


def _backend_constant(name: str) -> int:
    """Reads one numeric constant out of the backend's POLICY_DOMAIN."""
    source = POLICY_CONSTANTS_PATH.read_text(encoding="utf-8")
    # Values are either literals or small arithmetic expressions (`365 * 24 *
    # 60 * 60`), so the captured text is evaluated as a plain integer product.
    match = re.search(rf"^\s*{name}:\s*([0-9_ */+]+),", source, re.MULTILINE)
    if not match:
        pytest.fail(f"{name} not found in {POLICY_CONSTANTS_PATH}")

    expression = match.group(1).replace("_", "").strip()
    if not re.fullmatch(r"[0-9 */+]+", expression):
        pytest.fail(f"{name} has an unexpected value shape: {expression}")
    return int(eval(expression))


class TestDomainMirror:
    """The three copies of the domain rules must agree."""

    def test_minimum_premium_ratio_matches_the_backend(self) -> None:
        assert _backend_constant("minPremiumBps") == domain.MIN_PREMIUM_BPS

    def test_basis_points_denominator_matches_the_backend(self) -> None:
        assert (
            _backend_constant("basisPointsDenominator")
            == domain.BASIS_POINTS_DENOMINATOR
        )

    def test_maximum_duration_matches_the_backend(self) -> None:
        assert _backend_constant("maxDurationDays") == domain.MAX_DURATION_DAYS

    def test_region_byte_budget_matches_the_backend(self) -> None:
        assert _backend_constant("maxRegionCodeLength") == domain.MAX_REGION_CODE_BYTES

    def test_eth_decimals_match_the_backend(self) -> None:
        assert _backend_constant("maxEthDecimals") == domain.ETH_DECIMALS


class TestRequestContract:
    """Everything the backend sends must be accepted, under its own names."""

    def test_accepts_the_published_request_shape(self, backend_schemas: dict) -> None:
        required = backend_schemas["QuoteRequestDto"]["required"]

        # Built from the backend's own example values, keyed by its field names.
        request = QuoteRequest.model_validate(
            {
                "region": "Valencia",
                "startDate": "2026-04-01",
                "endDate": "2026-04-30",
                "coverageEth": "1.0",
                "rainfallThresholdMm": 50,
            }
        )

        for field in required:
            assert field in QuoteRequest.model_json_schema()["properties"], (
                f"The backend requires '{field}' but this service does not accept it"
            )
        assert request.region == "Valencia"

    def test_region_budget_matches_the_published_limit(
        self, backend_schemas: dict
    ) -> None:
        published = backend_schemas["QuoteRequestDto"]["properties"]["region"][
            "maxLength"
        ]
        assert published == domain.MAX_REGION_CODE_BYTES


class TestResponseContract:
    """Every field the backend's DTO requires must be produced."""

    def test_produces_every_required_response_field(
        self, backend_schemas: dict
    ) -> None:
        required = backend_schemas["QuoteResponseDto"]["required"]

        payload = QuoteResponse(
            region="Valencia",
            premium_eth="0.08",
            premium_wei="80000000000000000",
            start_date=date(2026, 4, 1),
            end_date=date(2026, 4, 30),
            model_version="baseline-premium-v1",
            trigger_probability=0.21,
            duration_days=30,
            region_known=True,
            floored_to_minimum=False,
        ).model_dump(mode="json", by_alias=True)

        missing = [field for field in required if field not in payload]
        assert not missing, (
            f"The backend's QuoteResponseDto requires {missing}, which this "
            f"service does not return"
        )

    def test_optional_model_version_is_populated(self, backend_schemas: dict) -> None:
        # Optional in the DTO, always sent here: a quote whose provenance is
        # unknown cannot be audited after the fact.
        assert "modelVersion" in backend_schemas["QuoteResponseDto"]["properties"]

        payload = QuoteResponse(
            region="Valencia",
            premium_eth="0.08",
            premium_wei="80000000000000000",
            start_date=date(2026, 4, 1),
            end_date=date(2026, 4, 30),
            model_version="baseline-premium-v1",
            trigger_probability=0.21,
            duration_days=30,
            region_known=True,
            floored_to_minimum=False,
        ).model_dump(mode="json", by_alias=True)

        assert payload["modelVersion"] == "baseline-premium-v1"

    def test_currency_defaults_to_the_chain_native_asset(self) -> None:
        payload = QuoteResponse(
            region="Valencia",
            premium_eth="0.08",
            premium_wei="80000000000000000",
            start_date=date(2026, 4, 1),
            end_date=date(2026, 4, 30),
            model_version="baseline-premium-v1",
            trigger_probability=0.21,
            duration_days=30,
            region_known=True,
            floored_to_minimum=False,
        ).model_dump(mode="json", by_alias=True)

        # Premiums are paid in the chain's native asset; anything else would
        # need a conversion the contract does not perform.
        assert payload["currency"] == "ETH"
