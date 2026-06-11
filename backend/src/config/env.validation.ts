import * as Joi from "joi";

import {
  CONFIG_DEFAULTS,
  DEPLOYED_PROFILES,
  RUNTIME_PROFILES,
} from "./config.defaults";

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

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

  // Blockchain integration metadata (consumed by the contract registry).
  BLOCKCHAIN_NETWORK: Joi.string()
    .trim()
    .empty("")
    .default(CONFIG_DEFAULTS.blockchainNetwork),
  CHAIN_ID: Joi.number().integer().positive().optional().allow(""),
  RPC_URL: Joi.string().uri().optional().allow(""),
  PRIVATE_KEY: Joi.string().optional().allow(""),
  FACTORY_ADDRESS: Joi.string()
    .pattern(EVM_ADDRESS_PATTERN)
    .message("FACTORY_ADDRESS must be a 0x-prefixed 20-byte hex address")
    .optional()
    .allow(""),
  SHARED_ABI_DIR: Joi.string().optional().allow(""),
  CONTRACTS_DEPLOYMENTS_DIR: Joi.string().optional().allow(""),

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
  ADMIN_API_KEY: Joi.string().optional().allow(""),

  // Optional Stage 11 off-chain persistence.
  DATABASE_URL: Joi.string().optional().allow(""),
});
