import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Min,
} from "class-validator";

import { MaxByteLength } from "../../../common/validation/max-byte-length.validator";
import {
  ethAmountMessage,
  POSITIVE_ETH_AMOUNT_REGEX,
} from "../../../common/utils/eth-amount.util";
import { POLICY_DOMAIN } from "../../policies/policy.constants";
import { IsOnOrAfter } from "../validators/date-range.validator";

/**
 * Request body for a premium quote. Mirrors the ML service `/predict` inputs
 * (region + coverage window) plus the risk parameters needed to price coverage.
 */
export class QuoteRequestDto {
  @ApiProperty({
    example: "Valencia",
    maxLength: POLICY_DOMAIN.maxRegionCodeLength,
    description:
      "Region identifier. Constrained to the same on-chain region budget as " +
      "policy creation so a quoted region is always insurable (quote -> create).",
  })
  @IsString()
  @IsNotEmpty()
  @MaxByteLength(POLICY_DOMAIN.maxRegionCodeLength)
  region!: string;

  @ApiProperty({
    example: "2026-04-01",
    description: "Coverage window start date (ISO-8601).",
  })
  @IsDateString()
  startDate!: string;

  @ApiProperty({
    example: "2026-04-30",
    description: "Coverage window end date (ISO-8601). Must be >= startDate.",
  })
  @IsDateString()
  @IsOnOrAfter("startDate")
  endDate!: string;

  @ApiProperty({ example: "1.0", description: "Coverage amount in ETH." })
  @Matches(POSITIVE_ETH_AMOUNT_REGEX, {
    message: ethAmountMessage("coverageEth"),
  })
  coverageEth!: string;

  @ApiProperty({
    example: 50,
    minimum: 1,
    description: "Rainfall threshold in millimeters that triggers a payout.",
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rainfallThresholdMm!: number;
}
