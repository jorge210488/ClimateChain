import { timingSafeEqual } from "node:crypto";

import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService, JwtSignOptions } from "@nestjs/jwt";

import { AppConfigService } from "../../config/app-config.service";
import { JwtPayload } from "./auth.types";
import { TokenResponse } from "./dto/token-response.dto";

/**
 * Issues administrative JWTs.
 *
 * Token issuance is enabled only when `ADMIN_API_KEY` is configured, keeping
 * local/dev profiles credential-free by default. The presented key is compared
 * in constant time. A persistent user store and richer identity flows arrive
 * with the optional Stage 11 persistence layer.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
  ) {}

  /** True when the administrative token endpoint is enabled. */
  isAdminTokenIssuanceEnabled(): boolean {
    return Boolean(this.config.auth.adminApiKey);
  }

  /** Exchanges a valid administrative API key for a signed JWT. */
  issueAdminToken(apiKey: string): TokenResponse {
    const adminApiKey = this.config.auth.adminApiKey;

    if (!adminApiKey) {
      throw new ServiceUnavailableException(
        "Administrative token issuance is disabled; set ADMIN_API_KEY to enable it",
      );
    }

    if (!this.safeEqual(apiKey, adminApiKey)) {
      throw new UnauthorizedException("Invalid administrative API key");
    }

    const payload: JwtPayload = { sub: "admin", roles: ["admin"] };
    const expiresIn = this.config.auth.jwtExpiresIn;
    const accessToken = this.jwtService.sign(payload, {
      expiresIn: expiresIn as JwtSignOptions["expiresIn"],
    });

    return { accessToken, tokenType: "Bearer", expiresIn };
  }

  private safeEqual(provided: string, expected: string): boolean {
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);

    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(providedBuffer, expectedBuffer);
  }
}
