import { CONFIG_DEFAULTS } from "./config.defaults";
import { configuration } from "./configuration";
import { CONFIG_NAMESPACE } from "./config.types";

/**
 * The Joi schema is the first line of defense for deployed profiles; these
 * cases cover the second one, which holds even if schema validation is
 * bypassed (a direct factory call, a harness that skips `validationSchema`).
 */
describe("configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const DEPLOYED_PRIVATE_KEY = `0x${"11".repeat(32)}`;

  function build() {
    return configuration()[CONFIG_NAMESPACE];
  }

  /** Minimum env for a deployed profile to pass the boot invariants. */
  function deployedEnv(): void {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "a-real-production-jwt-secret-value";
    process.env.RPC_URL = "https://rpc.example.com";
    process.env.CORS_ORIGINS = "https://app.example.com";
    process.env.PRIVATE_KEY = DEPLOYED_PRIVATE_KEY;
    process.env.CHAIN_CONFIRMATIONS = String(
      CONFIG_DEFAULTS.minDeployedConfirmations,
    );
  }

  it("resolves local defaults for the development profile", () => {
    process.env.NODE_ENV = "development";
    delete process.env.JWT_SECRET;
    delete process.env.RPC_URL;
    delete process.env.CORS_ORIGINS;
    delete process.env.SWAGGER_ENABLED;

    const config = build();

    expect(config.app.isDeployedProfile).toBe(false);
    expect(config.auth.jwtSecret).toBe(CONFIG_DEFAULTS.localJwtSecret);
    expect(config.auth.rateLimitTtlSeconds).toBe(
      CONFIG_DEFAULTS.authRateLimitTtlSeconds,
    );
    expect(config.auth.rateLimitMax).toBe(CONFIG_DEFAULTS.authRateLimitMax);
    // Empty allowlist means "reflect any origin", acceptable locally only.
    expect(config.app.corsOrigins).toEqual([]);
    expect(config.app.swaggerEnabled).toBe(true);
    expect(config.app.maxRequestBodySize).toBe(
      CONFIG_DEFAULTS.maxRequestBodySize,
    );
  });

  it("refuses to boot a deployed profile on the local JWT placeholder", () => {
    deployedEnv();
    delete process.env.JWT_SECRET;

    expect(() => build()).toThrow(/JWT_SECRET/);
  });

  it("refuses to boot a deployed profile without an RPC endpoint", () => {
    deployedEnv();
    delete process.env.RPC_URL;

    expect(() => build()).toThrow(/RPC_URL/);
  });

  it("refuses to boot a deployed profile without a CORS allowlist", () => {
    deployedEnv();
    delete process.env.CORS_ORIGINS;

    expect(() => build()).toThrow(/CORS_ORIGINS/);
  });

  it("refuses to boot a deployed profile without a signer", () => {
    // Mirrors the schema. This factory resolves its own values, so an invariant
    // enforced only in Joi is bypassed by any path that skips validation.
    deployedEnv();
    delete process.env.PRIVATE_KEY;

    expect(() => build()).toThrow(/PRIVATE_KEY/);
  });

  it("refuses to boot a deployed profile on a single confirmation", () => {
    deployedEnv();
    process.env.CHAIN_CONFIRMATIONS = "1";

    expect(() => build()).toThrow(/CHAIN_CONFIRMATIONS/);
  });

  it("accepts a fully configured deployed profile", () => {
    deployedEnv();

    const config = build();

    expect(config.app.isDeployedProfile).toBe(true);
    expect(config.logging.pretty).toBe(false);
    expect(config.app.corsOrigins).toEqual(["https://app.example.com"]);
    // Interactive docs are opt-in once deployed.
    expect(config.app.swaggerEnabled).toBe(false);
  });

  it("parses a multi-origin CORS allowlist", () => {
    deployedEnv();
    process.env.CORS_ORIGINS =
      " https://app.example.com , https://admin.example.com ,";

    expect(build().app.corsOrigins).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
    ]);
  });

  it("allows a deployed profile to opt back into docs", () => {
    deployedEnv();
    process.env.SWAGGER_ENABLED = "true";

    expect(build().app.swaggerEnabled).toBe(true);
  });

  it("allows a local profile to opt out of docs", () => {
    process.env.NODE_ENV = "development";
    process.env.SWAGGER_ENABLED = "false";

    expect(build().app.swaggerEnabled).toBe(false);
  });

  it("reads the auth rate-limit overrides", () => {
    process.env.NODE_ENV = "development";
    process.env.AUTH_RATE_LIMIT_TTL_SECONDS = "30";
    process.env.AUTH_RATE_LIMIT_MAX = "3";

    const config = build();

    expect(config.auth.rateLimitTtlSeconds).toBe(30);
    expect(config.auth.rateLimitMax).toBe(3);
  });
});
