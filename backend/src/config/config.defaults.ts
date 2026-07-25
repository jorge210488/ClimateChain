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
  /**
   * Fallback when no network is configured at all. `hardhat` is chosen because
   * its manifest is always present after a Stage 04 run, so the service boots
   * on a bare checkout. It is not the network to *run against*: that chain is
   * in-process and unreachable over RPC, so `.env.example` points at
   * `localhost` instead. See docs/runbooks/local-stack.md.
   */
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
  /**
   * Minimum length for `ADMIN_API_KEY`. The key is the only credential
   * protecting administrative JWT issuance, so it must not be guessable.
   */
  minAdminApiKeyLength: 32,
  /** Rolling window (seconds) for the administrative token endpoint limiter. */
  authRateLimitTtlSeconds: 60,
  /** Maximum token-issuance attempts per window, per client address. */
  authRateLimitMax: 10,
  /**
   * Maximum accepted request body size. The API takes small JSON documents
   * only, so a tight cap costs nothing and removes a cheap memory-pressure
   * vector. Express defaults to 100kb; this makes the intent explicit.
   */
  maxRequestBodySize: "64kb",
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
