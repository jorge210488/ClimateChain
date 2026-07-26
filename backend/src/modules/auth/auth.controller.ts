import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import { SkipThrottle, ThrottlerGuard } from "@nestjs/throttler";

import { POLICIES_THROTTLER } from "../../common/throttling/throttling.module";

import { ApiErrorResponse } from "../../common/dto/api-error-response.dto";
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
  // Rate limited: this is the only credential check guarding JWT issuance, so
  // an unthrottled endpoint is a brute-force oracle over ADMIN_API_KEY.
  // Only the auth budget applies; the policy read limiter is unrelated here.
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ [POLICIES_THROTTLER]: true })
  @Post("token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Exchange an administrative API key for a JWT",
    description:
      "Enabled only when ADMIN_API_KEY is configured; returns 503 otherwise. " +
      "Rate limited per client address (AUTH_RATE_LIMIT_MAX per " +
      "AUTH_RATE_LIMIT_TTL_SECONDS).",
  })
  @ApiOkResponse({ type: TokenResponse })
  @ApiTooManyRequestsResponse({
    type: ApiErrorResponse,
    description: "Too many token-issuance attempts from this client.",
  })
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
