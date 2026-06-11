import { ApiProperty } from "@nestjs/swagger";

import { PaginationMeta } from "../../../common/dto/paginated-response.dto";
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
    description: "Region code as a bytes32 hex string.",
    example:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
  })
  regionCode!: string;

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
}
