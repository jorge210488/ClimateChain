"""
Domain constants mirrored from the on-chain contracts.

`InsuranceProvider` is the authority: it reverts when a premium is below its
minimum ratio or a duration exceeds its maximum, and the backend mirrors the
same values in `POLICY_DOMAIN` to reject those requests before they cost gas.

This service is the third holder of that mirror, and the reason is specific: a
quote is only useful if the policy it describes can actually be created. A
premium below the on-chain floor, or a window longer than the contract accepts,
would produce a number the user cannot act on. Pricing therefore has to respect
the same bounds rather than discover them at settlement.

`tests/test_backend_contract.py` compares these against the backend's published
contract so the three copies cannot drift silently.
"""

from __future__ import annotations

# Denominator for basis-point maths (`BASIS_POINTS_DENOMINATOR`).
BASIS_POINTS_DENOMINATOR = 10_000

# Minimum premium as a fraction of coverage, in basis points (`MIN_PREMIUM_BPS`).
# 100 bps = 1%.
MIN_PREMIUM_BPS = 100

# Longest coverage window the provider will create (`MAX_DURATION_DAYS`).
MAX_DURATION_DAYS = 365

# Shortest window the API accepts. The contract rejects zero days; one day is
# the smallest window that can hold a weather observation.
MIN_DURATION_DAYS = 1

# Longest region identifier encodable into a `bytes32` region code, in UTF-8
# bytes. Not characters: an accented region name costs more than its length.
MAX_REGION_CODE_BYTES = 31

# Wei per ETH. Amounts cross this boundary as decimal strings and are handled
# as integers on both sides; no float ever touches a monetary value.
WEI_PER_ETH = 10**18
ETH_DECIMALS = 18


def minimum_premium_wei(coverage_wei: int) -> int:
    """
    Smallest premium the provider accepts for this coverage.

    Ceiling division, matching the contract's `Math.Rounding.Ceil`. Rounding the
    other way would produce quotes that are short by one wei and revert on
    creation — the failure would look random and be entirely deterministic.
    """
    return -(-coverage_wei * MIN_PREMIUM_BPS // BASIS_POINTS_DENOMINATOR)
