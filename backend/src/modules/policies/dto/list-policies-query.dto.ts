import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, Matches } from "class-validator";

import { PaginationQueryDto } from "../../../common/dto/pagination-query.dto";

/** Query parameters for listing policies, with optional insured filter. */
export class ListPoliciesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    example: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    description: "Filter policies by the insured account address.",
  })
  @IsOptional()
  @Matches(/^0x[a-fA-F0-9]{40}$/, {
    message: "insured must be a valid 0x-prefixed 20-byte EVM address",
  })
  insured?: string;
}
