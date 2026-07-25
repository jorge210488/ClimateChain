import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsOptional } from "class-validator";

import { PaginationQueryDto } from "../../../common/dto/pagination-query.dto";
import { normalizeEvmAddress } from "../../../common/utils/evm-address.util";
import { IsEvmAddress } from "../../../common/validation/is-evm-address.validator";

/** Query parameters for listing policies, with optional insured filter. */
export class ListPoliciesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    example: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    description:
      "Filter policies by the insured account address. Case-insensitive: the " +
      "value is normalized before it is matched against on-chain data.",
  })
  @IsOptional()
  @IsEvmAddress()
  // Transforms run before validators, which is harmless here: the address
  // predicate is case-insensitive, so a malformed value still fails validation.
  @Transform(({ value }) =>
    typeof value === "string" ? normalizeEvmAddress(value) : value,
  )
  insured?: string;
}
