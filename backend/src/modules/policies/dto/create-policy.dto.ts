import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  Matches,
  Max,
  Min,
} from "class-validator";

import { MaxByteLength } from "../../../common/validation/max-byte-length.validator";
import {
  ethAmountMessage,
  POSITIVE_ETH_AMOUNT_REGEX,
} from "../../../common/utils/eth-amount.util";
import { POLICY_DOMAIN } from "../policy.constants";
import {
  IsAfterMinLeadTime,
  REQUIRED_START_LEAD_TIME_SECONDS,
} from "../validators/min-lead-time.validator";
import { IsAtLeastMinPremium } from "../validators/min-premium.validator";
import { RequiresRegion } from "../validators/region-required-with-start.validator";

/** Request body for creating a parametric rainfall policy. */
export class CreatePolicyDto {
  @ApiProperty({
    example: "1.0",
    description: "Coverage (payout) amount in ETH.",
  })
  @Matches(POSITIVE_ETH_AMOUNT_REGEX, {
    message: ethAmountMessage("coverageEth"),
  })
  coverageEth!: string;

  @ApiProperty({
    example: "0.05",
    description:
      "Premium to fund in ETH (sent as transaction value). Must be at least " +
      `${POLICY_DOMAIN.minPremiumBps / 100}% of coverage on-chain.`,
  })
  @Matches(POSITIVE_ETH_AMOUNT_REGEX, {
    message: ethAmountMessage("premiumEth"),
  })
  @IsAtLeastMinPremium("coverageEth")
  premiumEth!: string;

  @ApiProperty({
    example: 50,
    minimum: 1,
    description: "Rainfall threshold in millimeters that triggers a payout.",
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rainfallThresholdMm!: number;

  @ApiProperty({
    example: 30,
    minimum: POLICY_DOMAIN.minDurationDays,
    maximum: POLICY_DOMAIN.maxDurationDays,
    description: "Coverage window length in days.",
  })
  @Type(() => Number)
  @IsInt()
  @Min(POLICY_DOMAIN.minDurationDays)
  @Max(POLICY_DOMAIN.maxDurationDays)
  durationDays!: number;

  @ApiPropertyOptional({
    example: "Valencia",
    maxLength: POLICY_DOMAIN.maxRegionCodeLength,
    description:
      "Human-readable region code. Encoded to bytes32 on-chain when provided; " +
      "must be non-empty (an empty code maps to the on-chain zero region).",
  })
  @IsOptional()
  @IsNotEmpty()
  @MaxByteLength(POLICY_DOMAIN.maxRegionCodeLength)
  region?: string;

  @ApiPropertyOptional({
    example: 1767225600,
    description:
      "Requested coverage start as a Unix timestamp (seconds). Defaults to a " +
      "near-future start on-chain when omitted. Requires `region` to be set, " +
      "since an explicit start is only honored on the on-chain metadata path. " +
      `Must be at least ${REQUIRED_START_LEAD_TIME_SECONDS} seconds ahead so ` +
      "it still satisfies the on-chain lead time once the transaction is mined.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @IsAfterMinLeadTime()
  @RequiresRegion("region")
  requestedStartTimestamp?: number;
}
