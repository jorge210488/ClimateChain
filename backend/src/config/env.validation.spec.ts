import { CONFIG_DEFAULTS } from "./config.defaults";
import { envValidationSchema } from "./env.validation";

describe("envValidationSchema", () => {
  it("resolves empty .env values to defaults for local profiles", () => {
    const { error, value } = envValidationSchema.validate(
      {
        NODE_ENV: "development",
        JWT_SECRET: "",
        PORT: "",
        LOG_LEVEL: "",
        BLOCKCHAIN_NETWORK: "",
        RPC_URL: "",
      },
      { abortEarly: false, allowUnknown: true },
    );

    expect(error).toBeUndefined();
    expect(value.JWT_SECRET).toBe(CONFIG_DEFAULTS.localJwtSecret);
    expect(value.PORT).toBe(CONFIG_DEFAULTS.port);
    expect(value.LOG_LEVEL).toBe(CONFIG_DEFAULTS.logLevel);
    expect(value.BLOCKCHAIN_NETWORK).toBe(CONFIG_DEFAULTS.blockchainNetwork);
  });

  it("applies defaults when keys are entirely absent", () => {
    const { error, value } = envValidationSchema.validate(
      {},
      { allowUnknown: true },
    );

    expect(error).toBeUndefined();
    expect(value.NODE_ENV).toBe(CONFIG_DEFAULTS.nodeEnv);
    expect(value.JWT_SECRET).toBe(CONFIG_DEFAULTS.localJwtSecret);
    expect(value.ML_SERVICE_BASE_URL).toBe(CONFIG_DEFAULTS.mlServiceBaseUrl);
  });

  it("requires a real JWT_SECRET for deployed profiles", () => {
    const { error } = envValidationSchema.validate(
      { NODE_ENV: "production", JWT_SECRET: "" },
      { abortEarly: false, allowUnknown: true },
    );

    expect(error).toBeDefined();
    expect(error?.message).toMatch(/JWT_SECRET/);
  });

  it("rejects a too-short JWT_SECRET", () => {
    const { error } = envValidationSchema.validate(
      { NODE_ENV: "production", JWT_SECRET: "short" },
      { allowUnknown: true },
    );

    expect(error).toBeDefined();
  });

  describe("RPC_URL", () => {
    const deployedEnv = {
      NODE_ENV: "production",
      JWT_SECRET: "a-real-production-jwt-secret-value",
      CORS_ORIGINS: "https://app.example.com",
    };

    it("is required for deployed profiles", () => {
      const { error } = envValidationSchema.validate(
        { ...deployedEnv, RPC_URL: "" },
        { abortEarly: false, allowUnknown: true },
      );

      expect(error).toBeDefined();
      expect(error?.message).toMatch(/RPC_URL/);
    });

    it("is accepted for deployed profiles when set", () => {
      const { error } = envValidationSchema.validate(
        { ...deployedEnv, RPC_URL: "https://rpc.example.com" },
        { abortEarly: false, allowUnknown: true },
      );

      expect(error).toBeUndefined();
    });

    it("stays optional for local profiles", () => {
      const { error } = envValidationSchema.validate(
        { NODE_ENV: "development", RPC_URL: "" },
        { allowUnknown: true },
      );

      expect(error).toBeUndefined();
    });
  });

  describe("CORS_ORIGINS", () => {
    it("is required for deployed profiles", () => {
      const { error } = envValidationSchema.validate(
        {
          NODE_ENV: "production",
          JWT_SECRET: "a-real-production-jwt-secret-value",
          RPC_URL: "https://rpc.example.com",
          CORS_ORIGINS: "",
        },
        { abortEarly: false, allowUnknown: true },
      );

      expect(error).toBeDefined();
      expect(error?.message).toMatch(/CORS_ORIGINS/);
    });

    it("stays optional for local profiles", () => {
      const { error } = envValidationSchema.validate(
        { NODE_ENV: "development", CORS_ORIGINS: "" },
        { allowUnknown: true },
      );

      expect(error).toBeUndefined();
    });
  });

  describe("PRIVATE_KEY", () => {
    it("rejects a malformed signer key", () => {
      const { error } = envValidationSchema.validate(
        { PRIVATE_KEY: "not-a-key" },
        { allowUnknown: true },
      );

      expect(error).toBeDefined();
      expect(error?.message).toMatch(/PRIVATE_KEY/);
    });

    it("accepts a 0x-prefixed 32-byte hex key", () => {
      const { error } = envValidationSchema.validate(
        { PRIVATE_KEY: `0x${"a".repeat(64)}` },
        { allowUnknown: true },
      );

      expect(error).toBeUndefined();
    });

    it("treats an empty value as unset", () => {
      const { error } = envValidationSchema.validate(
        { PRIVATE_KEY: "" },
        { allowUnknown: true },
      );

      expect(error).toBeUndefined();
    });
  });

  describe("ADMIN_API_KEY", () => {
    it("rejects a guessable key", () => {
      const { error } = envValidationSchema.validate(
        { ADMIN_API_KEY: "admin" },
        { allowUnknown: true },
      );

      expect(error).toBeDefined();
      expect(error?.message).toMatch(/ADMIN_API_KEY/);
    });

    it("accepts a key at the minimum length", () => {
      const { error } = envValidationSchema.validate(
        { ADMIN_API_KEY: "x".repeat(CONFIG_DEFAULTS.minAdminApiKeyLength) },
        { allowUnknown: true },
      );

      expect(error).toBeUndefined();
    });

    it("stays optional when unset, keeping issuance disabled", () => {
      const { error, value } = envValidationSchema.validate(
        { ADMIN_API_KEY: "" },
        { allowUnknown: true },
      );

      expect(error).toBeUndefined();
      expect(value.ADMIN_API_KEY).toBeUndefined();
    });
  });

  it("defaults the auth rate-limit window and budget", () => {
    const { error, value } = envValidationSchema.validate(
      { AUTH_RATE_LIMIT_TTL_SECONDS: "", AUTH_RATE_LIMIT_MAX: "" },
      { allowUnknown: true },
    );

    expect(error).toBeUndefined();
    expect(value.AUTH_RATE_LIMIT_TTL_SECONDS).toBe(
      CONFIG_DEFAULTS.authRateLimitTtlSeconds,
    );
    expect(value.AUTH_RATE_LIMIT_MAX).toBe(CONFIG_DEFAULTS.authRateLimitMax);
  });
});
