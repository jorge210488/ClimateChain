import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

/** Shared offset/limit pagination contract for list endpoints. */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    minimum: 0,
    default: 0,
    description: "Zero-based index of the first item to return.",
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  offset: number = 0;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 20,
    description: "Maximum number of items to return (capped at 100).",
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = 20;
}
