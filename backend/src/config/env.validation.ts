import * as Joi from "joi";

import {
  MAX_REQUEST_BODY_BYTES,
  MIN_REQUEST_BODY_BYTES,
  parseByteSize,
} from "../common/utils/byte-size.util";

import {
  CONFIG_DEFAULTS,
  DEPLOYED_PROFILES,
  RUNTIME_PROFILES,
} from "./config.defaults";

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Fail-fast environment validation schema.
 *
 * Defaults are sourced from `CONFIG_DEFAULTS` so validation and the runtime
 * configuration factory never diverge. Secrets required only by deployed
 * profiles stay optional for local/test/dev to keep onboarding frictionless.
 *
 * Defaulted fields use `.empty("")` so an empty value in a real `.env` file
 * (for example `JWT_SECRET=`) resolves to its default for local profiles
 * instead of failing validation. Deployed profiles still require real secrets.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid(...RUNTIME_PROFILES)
    .empty("")
    .default(CONFIG_DEFAULTS.nodeEnv),
  PORT: Joi.number().port().empty("").default(CONFIG_DEFAULTS.port),
  LOG_LEVEL: Joi.string()
    .valid("fatal", "error", "warn", "info", "debug", "trace", "silent")
    .empty("")
    .default(CONFIG_DEFAULTS.logLevel),

  // HTTP surface controls.
  // Comma-separated origin allowlist. Required for deployed profiles, which
  // must not reflect arbitrary origins.
  CORS_ORIGINS: Joi.string()
    .empty("")
    .when("NODE_ENV", {
      is: Joi.valid(...DEPLOYED_PROFILES),
      then: Joi.required().messages({
        "any.required":
          "CORS_ORIGINS is required for staging/testnet/production profiles",
      }),
      otherwise: Joi.optional(),
    }),
  // Defaults to enabled for local profiles and disabled for deployed ones.
  SWAGGER_ENABLED: Joi.boolean().empty("").optional(),
  // Validated by parsed value, not just by shape. Every failure mode here is
  // silent: an unreadable value leaves the parser with no limit at all, a
  // near-miss ("64kbb") becomes 64 *bytes* and rejects every request, and a
  // zero ("0", "0kb") passes any pattern check while doing the same.
  MAX_REQUEST_BODY_SIZE: Joi.string()
    .empty("")
    .default(CONFIG_DEFAULTS.maxRequestBodySize)
    .custom((value: string, helpers) => {
      const parsed = parseByteSize(value);

      if (parsed === undefined) {
        return helpers.message({
          custom:
            "MAX_REQUEST_BODY_SIZE must be a byte size such as 512, 64kb, or 1.5mb",
        });
      }
      if (parsed < MIN_REQUEST_BODY_BYTES) {
        return helpers.message({
          custom:
            `MAX_REQUEST_BODY_SIZE resolves to ${parsed} bytes, which would ` +
            `reject ordinary requests; use at least ${MIN_REQUEST_BODY_BYTES} bytes`,
        });
      }
      if (parsed > MAX_REQUEST_BODY_BYTES) {
        return helpers.message({
          custom:
            `MAX_REQUEST_BODY_SIZE resolves to ${parsed} bytes, above the ` +
            `${MAX_REQUEST_BODY_BYTES}-byte ceiling for this API`,
        });
      }

      return value;
    }),

  // Blockchain integration metadata (consumed by the contract registry).
  BLOCKCHAIN_NETWORK: Joi.string()
    .trim()
    .empty("")
    .default(CONFIG_DEFAULTS.blockchainNetwork),
  CHAIN_ID: Joi.number().integer().positive().optional().allow(""),
  // Deployed profiles must reach a real chain: enforced at boot rather than
  // only surfacing as a readiness failure once the process is already serving.
  RPC_URL: Joi.string()
    .uri()
    .empty("")
    .when("NODE_ENV", {
      is: Joi.valid(...DEPLOYED_PROFILES),
      then: Joi.required().messages({
        "any.required":
          "RPC_URL is required for staging/testnet/production profiles",
      }),
      otherwise: Joi.optional(),
    }),
  // Format-checked at boot so a malformed signer key fails here instead of on
  // the first Stage 06 transaction. Whether a signer is required at all is a
  // Stage 06 decision (backend-signed vs. user-signed transactions).
  PRIVATE_KEY: Joi.string()
    .pattern(PRIVATE_KEY_PATTERN)
    .message("PRIVATE_KEY must be a 0x-prefixed 32-byte hex string")
    .optional()
    .allow(""),
  FACTORY_ADDRESS: Joi.string()
    .pattern(EVM_ADDRESS_PATTERN)
    .message("FACTORY_ADDRESS must be a 0x-prefixed 20-byte hex address")
    .optional()
    .allow(""),
  SHARED_ABI_DIR: Joi.string().optional().allow(""),
  CONTRACTS_DEPLOYMENTS_DIR: Joi.string().optional().allow(""),

  // Chain client tuning (Stage 06).
  CHAIN_CONFIRMATIONS: Joi.number()
    .integer()
    .min(1)
    .empty("")
    .default(CONFIG_DEFAULTS.chainConfirmations),
  CHAIN_RPC_TIMEOUT_MS: Joi.number()
    .integer()
    .positive()
    .empty("")
    .default(CONFIG_DEFAULTS.chainRpcTimeoutMs),
  CHAIN_TX_TIMEOUT_MS: Joi.number()
    .integer()
    .positive()
    .empty("")
    .default(CONFIG_DEFAULTS.chainTxTimeoutMs),
  CHAIN_RETRY_ATTEMPTS: Joi.number()
    .integer()
    .min(1)
    .max(10)
    .empty("")
    .default(CONFIG_DEFAULTS.chainRetryAttempts),
  CHAIN_RETRY_BASE_DELAY_MS: Joi.number()
    .integer()
    .positive()
    .empty("")
    .default(CONFIG_DEFAULTS.chainRetryBaseDelayMs),
  CHAIN_MAX_PAGE_SIZE: Joi.number()
    .integer()
    .min(1)
    .max(200)
    .empty("")
    .default(CONFIG_DEFAULTS.chainMaxPageSize),
  CHAIN_READ_RATE_LIMIT_TTL_SECONDS: Joi.number()
    .integer()
    .positive()
    .empty("")
    .default(CONFIG_DEFAULTS.chainReadRateLimitTtlSeconds),
  CHAIN_READ_RATE_LIMIT_MAX: Joi.number()
    .integer()
    .positive()
    .empty("")
    .default(CONFIG_DEFAULTS.chainReadRateLimitMax),

  // ML pricing service integration (live calls wired in Stage 09).
  ML_SERVICE_BASE_URL: Joi.string()
    .uri()
    .empty("")
    .default(CONFIG_DEFAULTS.mlServiceBaseUrl),
  ML_SERVICE_TIMEOUT_MS: Joi.number()
    .integer()
    .positive()
    .empty("")
    .default(CONFIG_DEFAULTS.mlServiceTimeoutMs),

  // Auth: real secret required for deployed profiles, dev placeholder otherwise.
  JWT_SECRET: Joi.string()
    .min(16)
    .empty("")
    .when("NODE_ENV", {
      is: Joi.valid(...DEPLOYED_PROFILES),
      then: Joi.required(),
      otherwise: Joi.string().min(16).default(CONFIG_DEFAULTS.localJwtSecret),
    }),
  JWT_EXPIRES_IN: Joi.string().empty("").default(CONFIG_DEFAULTS.jwtExpiresIn),
  // Optional everywhere (unset disables admin token issuance), but when set it
  // is the sole credential guarding JWT issuance, so weak keys are rejected.
  ADMIN_API_KEY: Joi.string()
    .min(CONFIG_DEFAULTS.minAdminApiKeyLength)
    .empty("")
    .optional(),

  // Abuse controls for the administrative token endpoint.
  AUTH_RATE_LIMIT_TTL_SECONDS: Joi.number()
    .integer()
    .positive()
    .empty("")
    .default(CONFIG_DEFAULTS.authRateLimitTtlSeconds),
  AUTH_RATE_LIMIT_MAX: Joi.number()
    .integer()
    .positive()
    .empty("")
    .default(CONFIG_DEFAULTS.authRateLimitMax),

  // Optional Stage 11 off-chain persistence.
  DATABASE_URL: Joi.string().optional().allow(""),
});
