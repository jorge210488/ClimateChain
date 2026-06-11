import { ApiProperty } from "@nestjs/swagger";

/** Authenticated principal projection returned by `GET /auth/me`. */
export class AuthenticatedUserResponse {
  @ApiProperty({ example: "admin", description: "Principal identifier." })
  userId!: string;

  @ApiProperty({
    type: [String],
    example: ["admin"],
    description: "Roles granted to the principal.",
  })
  roles!: string[];
}
