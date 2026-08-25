import { CONFIG_DEFAULTS } from "./config.defaults";
import { envValidationSchema } from "./env.validation";

const DEPLOYED_PRIVATE_KEY = `0x${"11".repeat(32)}`;

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
        {
          ...deployedEnv,
          RPC_URL: "https://rpc.example.com",
          PRIVATE_KEY: DEPLOYED_PRIVATE_KEY,
          CHAIN_CONFIRMATIONS: 2,
        },
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

  describe("PRIVATE_KEY", () => {
    const deployedEnv = {
      NODE_ENV: "production",
      JWT_SECRET: "a-real-production-jwt-secret-value",
      CORS_ORIGINS: "https://app.example.com",
      RPC_URL: "https://rpc.example.com",
      CHAIN_CONFIRMATIONS: 2,
    };

    it("is required for deployed profiles", () => {
      // Stage 06 settled that this service signs its own transactions, so a
      // deployed instance without a key passes readiness and then fails every
      // POST /policies with a 503 — accepting traffic it cannot serve.
      const { error } = envValidationSchema.validate(
        { ...deployedEnv, PRIVATE_KEY: "" },
        { abortEarly: false, allowUnknown: true },
      );

      expect(error).toBeDefined();
      expect(error?.message).toMatch(/PRIVATE_KEY is required/);
    });

    it("is accepted for deployed profiles when set", () => {
      const { error } = envValidationSchema.validate(
        { ...deployedEnv, PRIVATE_KEY: DEPLOYED_PRIVATE_KEY },
        { abortEarly: false, allowUnknown: true },
      );

      expect(error).toBeUndefined();
    });

    it("stays optional for local profiles, where reads work unsigned", () => {
      const { error } = envValidationSchema.validate(
        { NODE_ENV: "development", PRIVATE_KEY: "" },
        { allowUnknown: true },
      );

      expect(error).toBeUndefined();
    });

    it("still rejects a malformed key on any profile", () => {
      const { error } = envValidationSchema.validate(
        { NODE_ENV: "development", PRIVATE_KEY: "not-a-key" },
        { allowUnknown: true },
      );

      expect(error?.message).toMatch(/0x-prefixed 32-byte hex/);
    });
  });

  describe("CHAIN_CONFIRMATIONS", () => {
    const deployedEnv = {
      NODE_ENV: "production",
      JWT_SECRET: "a-real-production-jwt-secret-value",
      CORS_ORIGINS: "https://app.example.com",
      RPC_URL: "https://rpc.example.com",
      PRIVATE_KEY: DEPLOYED_PRIVATE_KEY,
    };

    it("refuses a single confirmation on a deployed profile", () => {
      // Final on a local node, not on a public chain: one confirmation would
      // report policies that a reorganization then removes.
      const { error } = envValidationSchema.validate(
        { ...deployedEnv, CHAIN_CONFIRMATIONS: 1 },
        { abortEarly: false, allowUnknown: true },
      );

      expect(error).toBeDefined();
      expect(error?.message).toMatch(/CHAIN_CONFIRMATIONS must be at least 2/);
    });

    it("accepts the floor on a deployed profile", () => {
      const { error } = envValidationSchema.validate(
        { ...deployedEnv, CHAIN_CONFIRMATIONS: 2 },
        { abortEarly: false, allowUnknown: true },
      );

      expect(error).toBeUndefined();
    });

    it("still allows one confirmation locally", () => {
      const { error } = envValidationSchema.validate(
        { NODE_ENV: "development", CHAIN_CONFIRMATIONS: 1 },
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

  describe("MAX_REQUEST_BODY_SIZE", () => {
    it.each(["1kb", "64kb", "1.5mb", "2048"])("accepts %s", (value) => {
      const { error } = envValidationSchema.validate(
        { MAX_REQUEST_BODY_SIZE: value },
        { allowUnknown: true },
      );

      expect(error).toBeUndefined();
    });

    it.each(["0", "0b", "0kb", "0.0mb"])(
      "rejects %s, which would refuse every request",
      (value) => {
        // Passes any shape check while producing a limit that rejects all
        // non-empty bodies — a misconfiguration that looks like an outage.
        const { error } = envValidationSchema.validate(
          { MAX_REQUEST_BODY_SIZE: value },
          { allowUnknown: true },
        );

        expect(error).toBeDefined();
        expect(error?.message).toMatch(/reject ordinary requests/);
      },
    );

    it("rejects a value below a workable floor", () => {
      const { error } = envValidationSchema.validate(
        { MAX_REQUEST_BODY_SIZE: "16b" },
        { allowUnknown: true },
      );

      expect(error).toBeDefined();
    });

    it("rejects a value above the operational ceiling", () => {
      // More likely a typo (64mb for 64kb) than an intention, and a cheap
      // memory-pressure lever if accepted.
      const { error } = envValidationSchema.validate(
        { MAX_REQUEST_BODY_SIZE: "64mb" },
        { allowUnknown: true },
      );

      expect(error).toBeDefined();
      expect(error?.message).toMatch(/ceiling/);
    });

    it.each(["lots", "64kbb", "kb", "-5kb"])(
      "rejects unparseable value %s",
      (value) => {
        const { error } = envValidationSchema.validate(
          { MAX_REQUEST_BODY_SIZE: value },
          { allowUnknown: true },
        );

        expect(error).toBeDefined();
      },
    );
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
