/**
 * API-facing provider settlement stage, mirroring the on-chain
 * `InsuranceProvider.SettlementType` enum order: None(0), Payout(1), Expiry(2).
 *
 * This is provider-side accounting and is distinct from the policy's own
 * lifecycle status: a policy reports `PaidOut` once its payout executes, while
 * the provider separately records how it settled its reserve for that policy.
 */
export enum PolicySettlementType {
  None = "none",
  Payout = "payout",
  Expiry = "expiry",
}

/** On-chain enum index -> API settlement type, indexed by the contract's order. */
export const POLICY_SETTLEMENT_BY_INDEX: readonly PolicySettlementType[] = [
  PolicySettlementType.None,
  PolicySettlementType.Payout,
  PolicySettlementType.Expiry,
];

/** Maps an on-chain settlement index to the API value, throwing on unknown input. */
export function policySettlementFromIndex(index: number): PolicySettlementType {
  const settlement = POLICY_SETTLEMENT_BY_INDEX[index];
  if (settlement === undefined) {
    throw new Error(`Unknown on-chain settlement type index: ${index}`);
  }
  return settlement;
}
