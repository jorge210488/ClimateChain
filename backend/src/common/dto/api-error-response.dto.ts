import { ApiProperty } from "@nestjs/swagger";

/**
 * Canonical error response contract returned by the global exception filter.
 * Every error across the API conforms to this shape.
 */
export class ApiErrorResponse {
  @ApiProperty({ example: 400, description: "HTTP status code." })
  statusCode!: number;

  @ApiProperty({
    example: "Bad Request",
    description: "Short, machine-stable error label.",
  })
  error!: string;

  @ApiProperty({
    description:
      "Human-readable message or list of validation messages explaining the failure.",
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    example: ["coverageEth must be a positive number"],
  })
  message!: string | string[];

  @ApiProperty({ example: "POST", description: "HTTP method of the request." })
  method!: string;

  @ApiProperty({
    example: "/policies",
    description: "Request path that produced the error.",
  })
  path!: string;

  @ApiProperty({
    example: "2026-04-07T12:00:00.000Z",
    description: "ISO-8601 timestamp when the error was produced.",
  })
  timestamp!: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description: "Correlation id matching the `x-request-id` response header.",
    example: "f0c1d2e3-4567-8901-abcd-ef0123456789",
  })
  requestId?: string;
}
