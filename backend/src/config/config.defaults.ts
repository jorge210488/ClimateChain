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

  // --- Chain client (Stage 06) ---
  /**
   * Confirmations awaited before a write is reported as mined. One is correct
   * for a local node; public networks should raise it, since a single
   * confirmation can still be reorganized away.
   */
  chainConfirmations: 1,
  /** Per-RPC-call timeout. Beyond this the call is treated as transient. */
  chainRpcTimeoutMs: 10_000,
  /** How long to wait for a submitted transaction to be mined. */
  chainTxTimeoutMs: 120_000,
  /** Attempts for a transient RPC failure, including the first try. */
  chainRetryAttempts: 3,
  /** Base backoff between retries; grows exponentially with jitter. */
  chainRetryBaseDelayMs: 250,
  /**
   * Cap on how many policies one paginated read may pull from chain. Each item
   * costs several RPC calls, so an unbounded page would turn a single request
   * into a burst against the node.
   */
  chainMaxPageSize: 50,
  /**
   * Rate limit for the public policy read endpoints, per client address.
   *
   * These are anonymous and each one fans out into many RPC calls, so the limit
   * exists to protect the node and the RPC bill, not the API process.
   */
  chainReadRateLimitTtlSeconds: 60,
  chainReadRateLimitMax: 60,
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
