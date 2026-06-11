/**
 * Single source of truth for configuration defaults.
 *
 * These constants are referenced by both the Joi validation schema
 * (`env.validation.ts`) and the typed configuration factory
 * (`configuration.ts`) to guarantee defaults never drift between
 * validation and runtime resolution.
 */
export const CONFIG_DEFAULTS = {
  nodeEnv: "development",
  port: 3000,
  logLevel: "info",
  blockchainNetwork: "hardhat",
  mlServiceBaseUrl: "http://localhost:8000",
  mlServiceTimeoutMs: 5000,
  jwtExpiresIn: "1d",
  /**
   * Insecure placeholder used only for local/test/dev profiles so the API
   * can boot without manual secret setup. Deployed profiles (staging,
   * testnet, production) must override it; the schema enforces that.
   */
  localJwtSecret: "local-development-insecure-jwt-secret-change-me",
  /** Relative directory (from the backend working dir) holding shared ABIs. */
  sharedAbiDir: "../shared/abi",
  /** Relative directory (from the backend working dir) holding deployment manifests. */
  contractsDeploymentsDir: "../contracts/deployments",
} as const;

/** Environment profiles that require real, operator-provided secrets. */
export const DEPLOYED_PROFILES = ["staging", "testnet", "production"] as const;

/** All supported runtime profiles. */
export const RUNTIME_PROFILES = [
  "development",
  "test",
  ...DEPLOYED_PROFILES,
] as const;

export type RuntimeProfile = (typeof RUNTIME_PROFILES)[number];
