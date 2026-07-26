import { ApiProperty } from "@nestjs/swagger";

import { PaginationMeta } from "../../../common/dto/paginated-response.dto";
import { PolicySettlementType } from "../policy-settlement.enum";
import { PolicyStatus } from "../policy-status.enum";

/**
 * Normalized, API-facing projection of an on-chain policy. uint256 values are
 * serialized as strings to preserve precision. Populated by Stage 06 reads.
 */
export class PolicyResponseDto {
  @ApiProperty({ description: "Policy contract address." })
  address!: string;

  @ApiProperty({ description: "Insured account address." })
  insured!: string;

  @ApiProperty({ enum: PolicyStatus, enumName: "PolicyStatus" })
  status!: PolicyStatus;

  @ApiProperty({
    description: "Coverage amount in wei.",
    example: "1000000000000000000",
  })
  coverageWei!: string;

  @ApiProperty({
    description: "Premium amount in wei.",
    example: "50000000000000000",
  })
  premiumWei!: string;

  @ApiProperty({
    description: "Rainfall threshold in millimeters.",
    example: "50",
  })
  rainfallThresholdMm!: string;

  @ApiProperty({
    description: "Latest observed rainfall in millimeters.",
    example: "0",
  })
  latestRainfallMm!: string;

  @ApiProperty({ description: "Whether the payout condition has been met." })
  conditionMet!: boolean;

  @ApiProperty({
    description:
      "Coverage amount currently claimable by the insured, in wei. The " +
      "contract settles payouts pull-style: once a payout executes, the " +
      "insured must call the policy's claim entry point to receive the funds. " +
      "A non-zero value here means money is waiting to be claimed.",
    example: "0",
  })
  pendingPayoutWei!: string;

  @ApiProperty({
    description:
      "Unix timestamp (seconds) of the last oracle weather update, or 0 if " +
      "the policy has never been updated. Lets consumers detect stale data.",
    example: 0,
  })
  lastOracleUpdateTimestamp!: number;

  @ApiProperty({
    description: "Weather oracle adapter bound to this policy at deployment.",
  })
  oracle!: string;

  @ApiProperty({
    description: "Region code as stored on chain, as a bytes32 hex string.",
    example:
      "0x56616c656e636961000000000000000000000000000000000000000000000000",
  })
  regionCode!: string;

  @ApiProperty({
    required: false,
    nullable: true,
    example: "Valencia",
    description:
      "Region code decoded back to text. Absent when the on-chain value is " +
      "not decodable UTF-8 — policies created through the legacy entry point " +
      "store a keccak hash rather than a readable code.",
  })
  region?: string;

  @ApiProperty({
    description: "Coverage start as a Unix timestamp (seconds).",
    example: 1767225600,
  })
  startTimestamp!: number;

  @ApiProperty({
    description: "Coverage end as a Unix timestamp (seconds).",
    example: 1769817600,
  })
  endTimestamp!: number;

  @ApiProperty({ description: "Whether the coverage payout has been settled." })
  paidOut!: boolean;

  @ApiProperty({
    enum: PolicySettlementType,
    enumName: "PolicySettlementType",
    description:
      "How the provider settled its reserve for this policy. Distinct from " +
      "`status`, which tracks the policy's own lifecycle.",
  })
  settlementType!: PolicySettlementType;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      "Unix timestamp (seconds) when the provider recorded settlement, or " +
      "null while the policy is unsettled.",
    example: null,
  })
  settledAt?: number;
}

/** Paginated list of policies. */
export class PolicyListResponseDto {
  @ApiProperty({ type: [PolicyResponseDto] })
  data!: PolicyResponseDto[];

  @ApiProperty({ type: PaginationMeta })
  meta!: PaginationMeta;
}

/** Response returned after submitting a policy-creation transaction. */
export class CreatePolicyResponseDto {
  @ApiProperty({ description: "Created policy contract address." })
  address!: string;

  @ApiProperty({ description: "Transaction hash of the creation transaction." })
  transactionHash!: string;

  @ApiProperty({ enum: PolicyStatus, enumName: "PolicyStatus" })
  status!: PolicyStatus;

  @ApiProperty({
    description: "Block the creation transaction was mined in.",
    example: 42,
  })
  blockNumber!: number;

  @ApiProperty({
    description: "Gas consumed by the transaction.",
    example: "1517685",
  })
  gasUsed!: string;

  @ApiProperty({
    description:
      "Account the contract records as insured. The provider assigns this " +
      "from the transaction sender, so it is the backend's signer address.",
  })
  insured!: string;
}
