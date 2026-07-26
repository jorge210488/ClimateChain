import { ChainPolicy } from "./policy-chain.service";
import { PolicyResponseDto } from "./dto/policy-response.dto";

/**
 * Projects the normalized chain view onto the public response contract.
 *
 * Kept separate from the chain service so the wire format can evolve without
 * touching chain access, and so the mapping is directly testable without a node.
 */
export function toPolicyResponse(policy: ChainPolicy): PolicyResponseDto {
  return {
    address: policy.address,
    insured: policy.insured,
    status: policy.status,
    coverageWei: policy.coverageWei,
    premiumWei: policy.premiumWei,
    rainfallThresholdMm: policy.rainfallThresholdMm,
    latestRainfallMm: policy.latestRainfallMm,
    conditionMet: policy.conditionMet,
    pendingPayoutWei: policy.pendingPayoutWei,
    lastOracleUpdateTimestamp: policy.lastOracleUpdateTimestamp,
    oracle: policy.oracle,
    regionCode: policy.regionCode,
    region: policy.region,
    startTimestamp: policy.startTimestamp,
    endTimestamp: policy.endTimestamp,
    paidOut: policy.paidOut,
    settlementType: policy.settlementType,
    settledAt: policy.settledAt,
  };
}
