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

from app.core.domain import ETH_DECIMALS, MAX_ETH_INTEGER_DIGITS, WEI_PER_ETH

# The backend's POSITIVE_ETH_AMOUNT_REGEX, translated into a pattern that means
# the same thing in Python.
#
# Copying the characters was not enough. Python's `\d` matches every Unicode
# decimal, so Arabic-Indic and fullwidth digits both matched, and worse,
# `int()` parses them, so the service quoted 1 ETH for a coverage the backend
# refuses outright. JavaScript's `\d` is ASCII-only. `[0-9]` says so explicitly,
# in a place where a reader can see it.
#
# The end anchor is the other half: Python's `$` also matches before a trailing
# newline, so an amount ending in one passed validation and then threw on
# conversion — a 500 for what is a malformed request. `fullmatch` anchors both
# ends with no exceptions.
POSITIVE_ETH_AMOUNT_PATTERN = re.compile(r"(?!0+(\.0+)?$)[0-9]{1,30}(\.[0-9]{1,18})?")


def is_backend_consumable_amount(amount: str) -> bool:
    """
    Whether the backend would accept this string as an ETH amount.

    Applied to the premium this service *returns*, not only to the coverage it
    receives. A quote the backend cannot parse is worse than no quote: it looks
    usable and fails at the point of paying gas.
    """
    return isinstance(amount, str) and bool(
        POSITIVE_ETH_AMOUNT_PATTERN.fullmatch(amount)
    )


class InvalidEthAmountError(ValueError):
    """Raised when a string is not a valid non-negative ETH amount."""


def parse_eth_to_wei(amount: str) -> int:
    """
    Converts an ETH decimal string to integer wei.

    Zero is rejected, matching the backend: a policy with no coverage and a
    premium of nothing is not a thing the contract will create.

    :raises InvalidEthAmountError: when the string is malformed, over-precise,
        zero, or has more integer digits than the shared contract carries.
    """
    if not is_backend_consumable_amount(amount):
        raise InvalidEthAmountError(
            f"'{amount}' is not a positive ETH amount with at most "
            f"{MAX_ETH_INTEGER_DIGITS} integer digits and {ETH_DECIMALS} decimals"
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
