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

# Character-for-character the backend's POSITIVE_ETH_AMOUNT_REGEX.
#
# Copied rather than approximated, because "close enough" is what produced the
# divergences a review found: this pattern used to reject "01.0" that the
# backend accepts, and accept 31 integer digits that it rejects. Either
# direction breaks the quote -> create promise — one refuses business the chain
# would take, the other quotes a premium that cannot be submitted.
#
# The leading negative lookahead rejects zero in all its spellings; `\d{1,30}`
# caps integer digits; the optional group caps fractional digits at 18.
POSITIVE_ETH_AMOUNT_PATTERN = re.compile(r"^(?!0+(\.0+)?$)\d{1,30}(\.\d{1,18})?$")


def is_backend_consumable_amount(amount: str) -> bool:
    """
    Whether the backend would accept this string as an ETH amount.

    Applied to the premium this service *returns*, not only to the coverage it
    receives. A quote the backend cannot parse is worse than no quote: it looks
    usable and fails at the point of paying gas.
    """
    return isinstance(amount, str) and bool(POSITIVE_ETH_AMOUNT_PATTERN.match(amount))


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
    if not isinstance(amount, str) or not POSITIVE_ETH_AMOUNT_PATTERN.match(amount):
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
