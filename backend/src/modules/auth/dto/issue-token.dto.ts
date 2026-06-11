import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

/** Request body to exchange an administrative API key for a JWT. */
export class IssueTokenDto {
  @ApiProperty({
    description:
      "Administrative API key (matched against ADMIN_API_KEY) exchanged " +
      "for a short-lived JWT.",
  })
  @IsString()
  @IsNotEmpty()
  apiKey!: string;
}
