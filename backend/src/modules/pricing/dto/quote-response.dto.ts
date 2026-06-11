import { ApiProperty } from "@nestjs/swagger";

/** Premium quote response contract. Populated from the ML service in Stage 09. */
export class QuoteResponseDto {
  @ApiProperty({
    example: "Valencia",
    description: "Region the quote applies to.",
  })
  region!: string;

  @ApiProperty({ example: "0.08", description: "Suggested premium in ETH." })
  premiumEth!: string;

  @ApiProperty({
    example: "80000000000000000",
    description: "Suggested premium in wei.",
  })
  premiumWei!: string;

  @ApiProperty({ example: "ETH", description: "Premium currency." })
  currency!: string;

  @ApiProperty({
    example: "2026-04-01",
    description: "Coverage window start date.",
  })
  startDate!: string;

  @ApiProperty({
    example: "2026-04-30",
    description: "Coverage window end date.",
  })
  endDate!: string;

  @ApiProperty({
    required: false,
    nullable: true,
    example: "prophet-v1",
    description: "Identifier of the pricing model that produced the quote.",
  })
  modelVersion?: string;
}
