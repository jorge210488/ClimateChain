"""
Exact conversion between ETH decimal strings and integer wei.

Mirrors `backend/src/common/utils/eth-amount.util.ts`, deliberately including
its refusal to involve floating point. A premium is a monetary amount compared
against an on-chain threshold; `float` cannot represent 0.1 exactly, so a value
that round-trips through one can be short by a wei and revert on creation.

Amounts therefore travel as decimal strings and are computed as integers.
"""

from __future__ import annotations

import re

from app.core.domain import ETH_DECIMALS, WEI_PER_ETH

# Same shape the backend accepts: a positive decimal with at most 18 places and
# no exponent, sign, or separators.
POSITIVE_ETH_AMOUNT_PATTERN = re.compile(r"^(?:0|[1-9]\d*)(?:\.\d{1,18})?$")


class InvalidEthAmountError(ValueError):
    """Raised when a string is not a valid non-negative ETH amount."""


def parse_eth_to_wei(amount: str) -> int:
    """
    Converts an ETH decimal string to integer wei.

    :raises InvalidEthAmountError: when the string is malformed or over-precise.
    """
    if not isinstance(amount, str) or not POSITIVE_ETH_AMOUNT_PATTERN.match(amount):
        raise InvalidEthAmountError(
            f"'{amount}' is not a positive ETH amount with at most "
            f"{ETH_DECIMALS} decimals"
        )

    whole, _, fraction = amount.partition(".")
    padded = (fraction + "0" * ETH_DECIMALS)[:ETH_DECIMALS]
    return int(whole) * WEI_PER_ETH + int(padded)


def format_wei_to_eth(amount_wei: int) -> str:
    """
    Renders integer wei as an ETH decimal string, without trailing zeros.

    The inverse of :func:`parse_eth_to_wei` for every value it produces, so a
    quote can be echoed back into policy creation unchanged.
    """
    if amount_wei < 0:
        raise InvalidEthAmountError("wei amount must not be negative")

    whole, remainder = divmod(amount_wei, WEI_PER_ETH)
    if remainder == 0:
        return f"{whole}.0"

    fraction = f"{remainder:0{ETH_DECIMALS}d}".rstrip("0")
    return f"{whole}.{fraction}"
