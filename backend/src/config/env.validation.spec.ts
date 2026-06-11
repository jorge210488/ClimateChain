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
});
