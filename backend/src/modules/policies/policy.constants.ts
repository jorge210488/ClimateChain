/**
 * Domain constants mirroring the `InsuranceProvider` contract (Stage 03/04).
 *
 * The contract remains the authoritative source and reverts on violation;
 * these values drive early DTO validation and API documentation. Stage 06 can
 * additionally verify them against on-chain reads of the public constants.
 */
export const POLICY_DOMAIN = {
  /** `MAX_DURATION_DAYS` */
  maxDurationDays: 365,
  /** Minimum sensible duration enforced by the API. */
  minDurationDays: 1,
  /** `MIN_PREMIUM_BPS` — premium must be at least this fraction of coverage. */
  minPremiumBps: 100,
  /** `BASIS_POINTS_DENOMINATOR` */
  basisPointsDenominator: 10_000,
  /** `MIN_POLICY_START_LEAD_TIME_SECONDS` */
  minPolicyStartLeadTimeSeconds: 60,
  /**
   * Extra margin required on top of the on-chain lead time.
   *
   * The contract compares `requestedStartTimestamp` against `block.timestamp`
   * at mining time, while this API validates against wall-clock time at request
   * time. Without a margin, a request accepted at exactly the on-chain minimum
   * reverts once queueing, signing, and block inclusion have elapsed. The
   * margin covers that gap so an accepted request stays executable.
   */
  startLeadTimeSafetyMarginSeconds: 120,
  /** Maximum UTF-8 byte length encodable into a `bytes32` region code. */
  maxRegionCodeLength: 31,
  /** Maximum supported decimals when parsing ETH-denominated amounts. */
  maxEthDecimals: 18,
} as const;
