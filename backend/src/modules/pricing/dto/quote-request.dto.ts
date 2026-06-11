import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

import {
  ethAmountMessage,
  POSITIVE_ETH_AMOUNT_REGEX,
} from "../../../common/utils/eth-amount.util";

/**
 * Request body for a premium quote. Mirrors the ML service `/predict` inputs
 * (region + coverage window) plus the risk parameters needed to price coverage.
 */
export class QuoteRequestDto {
  @ApiProperty({ example: "Valencia", description: "Region identifier." })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  region!: string;

  @ApiProperty({
    example: "2026-04-01",
    description: "Coverage window start date (ISO-8601).",
  })
  @IsDateString()
  startDate!: string;

  @ApiProperty({
    example: "2026-04-30",
    description: "Coverage window end date (ISO-8601).",
  })
  @IsDateString()
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
