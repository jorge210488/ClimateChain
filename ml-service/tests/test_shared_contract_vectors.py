"""
Runs the shared pricing-request vectors against this service's schema.

`tests/test_backend_contract.py` compares published field names and limits,
which is a weaker claim than it looks: every one of its assertions passed while
the two services disagreed on whether a timestamp is a date and on whether a
padded region is the same region. Shape agreement is not behaviour agreement.

These vectors are the behaviour. The backend runs the identical file in
`quote-request.dto.spec.ts`, so a rule changed on one side and not the other
fails on both.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.schemas.pricing import CALENDAR_DATE_PATTERN, QuoteRequest

VECTORS_PATH = (
    Path(__file__).resolve().parents[2]
    / "shared/contracts/pricing-request-vectors.json"
)


def load_vectors() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not VECTORS_PATH.is_file():
        pytest.fail(f"Shared contract vectors are missing at {VECTORS_PATH}")
    document = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    return document["base"], document["vectors"]


BASE, VECTORS = load_vectors()


@pytest.mark.parametrize("vector", VECTORS, ids=[vector["name"] for vector in VECTORS])
def test_matches_the_shared_contract(vector: dict[str, Any]) -> None:
    payload = {**BASE, **vector["override"]}
    should_accept = vector["expect"] == "accept"

    try:
        QuoteRequest.model_validate(payload)
        accepted = True
        detail = ""
    except ValidationError as error:
        accepted = False
        detail = str(error)

    assert accepted == should_accept, (
        f"{vector['name']}: the shared contract says {vector['expect']}, this "
        f"service {'accepted' if accepted else 'rejected'} it. "
        f"{vector.get('why', '')} {detail}"
    )


def test_the_region_identifier_survives_validation() -> None:
    # The consequence behind the "preserved verbatim" vector: the backend
    # encodes the region into bytes32 exactly as sent, so a trimmed echo would
    # quote one region and insure another.
    request = QuoteRequest.model_validate({**BASE, "region": "  Valencia  "})

    assert request.region == "  Valencia  "


@pytest.mark.parametrize(
    "value",
    [
        "\u0662\u0660\u0662\u0666-\u0660\u0664-\u0660\u0661",
        "\uff12\uff10\uff12\uff16-\uff10\uff14-\uff10\uff11",
    ],
)
def test_date_syntax_is_ascii_only(value: str) -> None:
    # Python's `\d` includes these numeral systems while the backend's
    # JavaScript validator does not. Keep this guard independent of whatever
    # date coercion Pydantic happens to provide.
    assert CALENDAR_DATE_PATTERN.fullmatch(value) is None


def test_every_vector_is_exercised() -> None:
    # Guards against a vectors file that silently stops containing cases.
    assert len(VECTORS) >= 25
    assert {vector["expect"] for vector in VECTORS} == {"accept", "reject"}
