import {
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import { AppConfigService } from "../../config/app-config.service";
import { AuthConfig } from "../../config/config.types";
import { AuthService } from "./auth.service";

const SECRET = "unit-test-jwt-secret-0123456789";

function buildConfig(auth: Partial<AuthConfig>): AppConfigService {
  const merged: AuthConfig = {
    jwtSecret: SECRET,
    jwtExpiresIn: "1h",
    rateLimitTtlSeconds: 60,
    rateLimitMax: 10,
    ...auth,
  };
  return { auth: merged } as AppConfigService;
}

describe("AuthService", () => {
  const jwtService = new JwtService({ secret: SECRET });

  it("reports issuance disabled and rejects when ADMIN_API_KEY is unset", () => {
    const service = new AuthService(
      jwtService,
      buildConfig({ adminApiKey: undefined }),
    );

    expect(service.isAdminTokenIssuanceEnabled()).toBe(false);
    expect(() => service.issueAdminToken("anything")).toThrow(
      ServiceUnavailableException,
    );
  });

  it("rejects an invalid administrative API key", () => {
    const service = new AuthService(
      jwtService,
      buildConfig({ adminApiKey: "correct-key" }),
    );

    expect(service.isAdminTokenIssuanceEnabled()).toBe(true);
    expect(() => service.issueAdminToken("wrong-key")).toThrow(
      UnauthorizedException,
    );
  });

  it("issues a verifiable admin token for the correct key", () => {
    const service = new AuthService(
      jwtService,
      buildConfig({ adminApiKey: "correct-key" }),
    );

    const result = service.issueAdminToken("correct-key");

    expect(result.tokenType).toBe("Bearer");
    expect(result.expiresIn).toBe("1h");
    const decoded = jwtService.verify<{ sub: string; roles: string[] }>(
      result.accessToken,
      { secret: SECRET },
    );
    expect(decoded.sub).toBe("admin");
    expect(decoded.roles).toEqual(["admin"]);
  });
});
