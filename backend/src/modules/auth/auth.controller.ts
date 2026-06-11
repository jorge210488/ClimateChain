import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { AuthenticatedUser } from "./auth.types";
import { AuthService } from "./auth.service";
import { CurrentUser } from "./current-user.decorator";
import { AuthenticatedUserResponse } from "./dto/authenticated-user-response.dto";
import { IssueTokenDto } from "./dto/issue-token.dto";
import { TokenResponse } from "./dto/token-response.dto";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Exchange an administrative API key for a JWT",
    description:
      "Enabled only when ADMIN_API_KEY is configured; returns 503 otherwise.",
  })
  @ApiOkResponse({ type: TokenResponse })
  issueToken(@Body() dto: IssueTokenDto): TokenResponse {
    return this.authService.issueAdminToken(dto.apiKey);
  }

  @Roles("admin")
  @Get("me")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Return the authenticated administrative principal",
  })
  @ApiOkResponse({ type: AuthenticatedUserResponse })
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUserResponse {
    return { userId: user.userId, roles: user.roles };
  }
}
