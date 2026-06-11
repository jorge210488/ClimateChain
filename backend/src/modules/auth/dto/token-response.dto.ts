import { ApiProperty } from "@nestjs/swagger";

/** JWT issuance response contract. */
export class TokenResponse {
  @ApiProperty({ description: "Signed JWT access token." })
  accessToken!: string;

  @ApiProperty({ example: "Bearer", description: "Token scheme." })
  tokenType!: string;

  @ApiProperty({
    example: "1d",
    description: "Token lifetime as configured by JWT_EXPIRES_IN.",
  })
  expiresIn!: string;
}
