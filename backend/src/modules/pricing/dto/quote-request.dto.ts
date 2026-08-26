import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsString, Matches, Min } from "class-validator";

import { IsSafeInteger } from "../../../common/validation/is-safe-integer.validator";
import { MaxByteLength } from "../../../common/validation/max-byte-length.validator";
import {
  ethAmountMessage,
  POSITIVE_ETH_AMOUNT_REGEX,
} from "../../../common/utils/eth-amount.util";
import { POLICY_DOMAIN } from "../../policies/policy.constants";
import {
  IsOnOrAfter,
  IsWithinMaxCoverageWindow,
} from "../validators/date-range.validator";

/** A calendar date with zero-padded month and day, and nothing else. */
const CALENDAR_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** At least one character that is not whitespace. */
const NON_BLANK_REGEX = /\S/;

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
  // Not `@IsNotEmpty()`: it rejects only the empty string, so a region of
  // spaces passed validation and would have been encoded on-chain as a bytes32
  // of whitespace. The value itself is kept verbatim — the region code is
  // derived from exactly what the caller sent, so trimming it here would quote
  // one region and insure another.
  @Matches(NON_BLANK_REGEX, {
    message: "region must contain at least one non-whitespace character",
  })
  @MaxByteLength(POLICY_DOMAIN.maxRegionCodeLength)
  region!: string;

  @ApiProperty({
    example: "2026-04-01",
    description: "Coverage window start date, as YYYY-MM-DD.",
  })
  // Calendar dates only. `@IsDateString()` also accepts a full ISO timestamp,
  // which has no meaning for coverage measured in whole days and leaves two
  // readings of the same window. The ML service takes dates, so accepting more
  // here would let a request pass the backend and fail downstream.
  @Matches(CALENDAR_DATE_REGEX, {
    message: "startDate must be a calendar date in YYYY-MM-DD form",
  })
  startDate!: string;

  @ApiProperty({
    example: "2026-04-30",
    description:
      "Coverage window end date, as YYYY-MM-DD. Must be >= startDate.",
  })
  @Matches(CALENDAR_DATE_REGEX, {
    message: "endDate must be a calendar date in YYYY-MM-DD form",
  })
  @IsOnOrAfter("startDate")
  @IsWithinMaxCoverageWindow("startDate")
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
  @IsSafeInteger()
  @Min(1)
  rainfallThresholdMm!: number;
}
