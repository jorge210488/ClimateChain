/**
 * API-facing policy status, mirroring the on-chain `InsurancePolicy.PolicyStatus`
 * enum order: Created(0), Active(1), Triggered(2), PaidOut(3), Expired(4).
 */
export enum PolicyStatus {
  Created = "created",
  Active = "active",
  Triggered = "triggered",
  PaidOut = "paid_out",
  Expired = "expired",
}

/** On-chain enum index -> API status, indexed by the contract's enum order. */
export const POLICY_STATUS_BY_INDEX: readonly PolicyStatus[] = [
  PolicyStatus.Created,
  PolicyStatus.Active,
  PolicyStatus.Triggered,
  PolicyStatus.PaidOut,
  PolicyStatus.Expired,
];

/** Maps an on-chain status index to the API status, throwing on unknown values. */
export function policyStatusFromIndex(index: number): PolicyStatus {
  const status = POLICY_STATUS_BY_INDEX[index];
  if (status === undefined) {
    throw new Error(`Unknown on-chain policy status index: ${index}`);
  }
  return status;
}
