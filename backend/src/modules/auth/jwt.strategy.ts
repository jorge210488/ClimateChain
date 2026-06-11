import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import { AppConfigService } from "../../config/app-config.service";
import { AuthenticatedUser, JwtPayload } from "./auth.types";

/**
 * Validates `Bearer` JWTs signed with the configured `JWT_SECRET` and maps the
 * verified payload to the request principal.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: AppConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.auth.jwtSecret,
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    if (!payload || typeof payload.sub !== "string") {
      throw new UnauthorizedException("Invalid token payload");
    }
    return {
      userId: payload.sub,
      roles: Array.isArray(payload.roles) ? payload.roles : [],
    };
  }
}
