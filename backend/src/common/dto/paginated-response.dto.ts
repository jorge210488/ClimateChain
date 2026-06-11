import { ApiProperty } from "@nestjs/swagger";

/** Pagination metadata accompanying every paginated list response. */
export class PaginationMeta {
  @ApiProperty({ description: "Total number of items available.", example: 42 })
  total!: number;

  @ApiProperty({ description: "Offset applied to this page.", example: 0 })
  offset!: number;

  @ApiProperty({ description: "Limit applied to this page.", example: 20 })
  limit!: number;

  @ApiProperty({ description: "Number of items in this page.", example: 20 })
  count!: number;
}

/** Generic paginated result envelope used by list endpoints. */
export interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMeta;
}

/** Builds a {@link PaginatedResult} from a page slice and total count. */
export function buildPaginatedResult<T>(
  data: T[],
  total: number,
  offset: number,
  limit: number,
): PaginatedResult<T> {
  return {
    data,
    meta: { total, offset, limit, count: data.length },
  };
}
