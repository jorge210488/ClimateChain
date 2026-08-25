import { resolve } from "node:path";

import { CONFIG_DEFAULTS, DEPLOYED_PROFILES } from "./config.defaults";
import { CONFIG_NAMESPACE, RootConfig } from "./config.types";
import type { RuntimeProfile } from "./config.defaults";

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumber(value: string | undefined): number | undefined {
  const normalized = optionalString(value);
  if (normalized === undefined) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parses a comma-separated list, dropping empty entries. */
function optionalList(value: string | undefined): string[] {
  return (optionalString(value) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Parses a boolean-ish env flag, falling back when unset. */
function optionalBoolean(
  value: string | undefined,
  fallback: boolean,
): boolean {
  const normalized = optionalString(value)?.toLowerCase();
  if (normalized === undefined) {
    return fallback;
  }
  return normalized === "true" || normalized === "1";
}

function resolveDir(
  override: string | undefined,
  fallbackRelative: string,
): string {
  const candidate = optionalString(override) ?? fallbackRelative;
  return resolve(process.cwd(), candidate);
}

/**
 * Typed configuration factory consumed by `@nestjs/config`.
 *
 * Values are read from the already validated environment. Defaults are taken
 * from `CONFIG_DEFAULTS` so this factory stays consistent with the Joi schema
 * even if upstream default propagation changes.
 */
export function configuration(): Record<string, RootConfig> {
  const env = process.env;

  const nodeEnv = (optionalString(env.NODE_ENV) ??
    CONFIG_DEFAULTS.nodeEnv) as RuntimeProfile;
  const isDeployedProfile = (DEPLOYED_PROFILES as readonly string[]).includes(
    nodeEnv,
  );

  const config: RootConfig = {
    app: {
      nodeEnv,
      port: optionalNumber(env.PORT) ?? CONFIG_DEFAULTS.port,
      isDeployedProfile,
      corsOrigins: optionalList(env.CORS_ORIGINS),
      // Interactive docs describe every route and payload shape, so they are
      // opt-in for deployed profiles rather than exposed by default.
      swaggerEnabled: optionalBoolean(env.SWAGGER_ENABLED, !isDeployedProfile),
      maxRequestBodySize:
        optionalString(env.MAX_REQUEST_BODY_SIZE) ??
        CONFIG_DEFAULTS.maxRequestBodySize,
      // No default: trusting a proxy that is not there hands every caller a
      // spoofable client address, which is worse than metering the proxy.
      trustProxy: optionalString(env.TRUST_PROXY),
    },
    blockchain: {
      network:
        optionalString(env.BLOCKCHAIN_NETWORK) ??
        CONFIG_DEFAULTS.blockchainNetwork,
      chainId: optionalNumber(env.CHAIN_ID),
      rpcUrl: optionalString(env.RPC_URL),
      privateKey: optionalString(env.PRIVATE_KEY),
      factoryAddress: optionalString(env.FACTORY_ADDRESS),
      sharedAbiDir: resolveDir(
        env.SHARED_ABI_DIR,
        CONFIG_DEFAULTS.sharedAbiDir,
      ),
      deploymentsDir: resolveDir(
        env.CONTRACTS_DEPLOYMENTS_DIR,
        CONFIG_DEFAULTS.contractsDeploymentsDir,
      ),
      confirmations:
        optionalNumber(env.CHAIN_CONFIRMATIONS) ??
        CONFIG_DEFAULTS.chainConfirmations,
      rpcTimeoutMs:
        optionalNumber(env.CHAIN_RPC_TIMEOUT_MS) ??
        CONFIG_DEFAULTS.chainRpcTimeoutMs,
      txTimeoutMs:
        optionalNumber(env.CHAIN_TX_TIMEOUT_MS) ??
        CONFIG_DEFAULTS.chainTxTimeoutMs,
      retryAttempts:
        optionalNumber(env.CHAIN_RETRY_ATTEMPTS) ??
        CONFIG_DEFAULTS.chainRetryAttempts,
      retryBaseDelayMs:
        optionalNumber(env.CHAIN_RETRY_BASE_DELAY_MS) ??
        CONFIG_DEFAULTS.chainRetryBaseDelayMs,
      maxPageSize:
        optionalNumber(env.CHAIN_MAX_PAGE_SIZE) ??
        CONFIG_DEFAULTS.chainMaxPageSize,
      readRateLimitTtlSeconds:
        optionalNumber(env.CHAIN_READ_RATE_LIMIT_TTL_SECONDS) ??
        CONFIG_DEFAULTS.chainReadRateLimitTtlSeconds,
      readRateLimitMax:
        optionalNumber(env.CHAIN_READ_RATE_LIMIT_MAX) ??
        CONFIG_DEFAULTS.chainReadRateLimitMax,
    },
    mlService: {
      baseUrl:
        optionalString(env.ML_SERVICE_BASE_URL) ??
        CONFIG_DEFAULTS.mlServiceBaseUrl,
      timeoutMs:
        optionalNumber(env.ML_SERVICE_TIMEOUT_MS) ??
        CONFIG_DEFAULTS.mlServiceTimeoutMs,
    },
    auth: {
      jwtSecret:
        optionalString(env.JWT_SECRET) ?? CONFIG_DEFAULTS.localJwtSecret,
      jwtExpiresIn:
        optionalString(env.JWT_EXPIRES_IN) ?? CONFIG_DEFAULTS.jwtExpiresIn,
      adminApiKey: optionalString(env.ADMIN_API_KEY),
      rateLimitTtlSeconds:
        optionalNumber(env.AUTH_RATE_LIMIT_TTL_SECONDS) ??
        CONFIG_DEFAULTS.authRateLimitTtlSeconds,
      rateLimitMax:
        optionalNumber(env.AUTH_RATE_LIMIT_MAX) ??
        CONFIG_DEFAULTS.authRateLimitMax,
    },
    logging: {
      level: optionalString(env.LOG_LEVEL) ?? CONFIG_DEFAULTS.logLevel,
      pretty: !isDeployedProfile,
    },
    persistence: {
      databaseUrl: optionalString(env.DATABASE_URL),
    },
  };

  assertDeployedProfileInvariants(config);

  return { [CONFIG_NAMESPACE]: config };
}

/**
 * Defense in depth for deployed profiles.
 *
 * The Joi schema already rejects a missing `JWT_SECRET`/`RPC_URL` for
 * staging/testnet/production, and `@nestjs/config` writes validated values back
 * to `process.env`. This factory nevertheless resolves its own defaults, so it
 * would silently fall back to the insecure local placeholder if schema
 * validation were ever bypassed (a skipped `validationSchema`, a direct call in
 * a test harness). Re-asserting here means no code path can boot a deployed
 * profile on development credentials.
 */
function assertDeployedProfileInvariants(config: RootConfig): void {
  if (!config.app.isDeployedProfile) {
    return;
  }

  if (config.auth.jwtSecret === CONFIG_DEFAULTS.localJwtSecret) {
    throw new Error(
      `JWT_SECRET resolves to the insecure local development placeholder for ` +
        `profile "${config.app.nodeEnv}". Set a real JWT_SECRET.`,
    );
  }

  if (!config.blockchain.rpcUrl) {
    throw new Error(
      `RPC_URL is not configured for profile "${config.app.nodeEnv}". ` +
        `Deployed profiles must target a real JSON-RPC endpoint.`,
    );
  }

  if (config.app.corsOrigins.length === 0) {
    throw new Error(
      `CORS_ORIGINS is not configured for profile "${config.app.nodeEnv}". ` +
        `Deployed profiles must declare an explicit origin allowlist instead ` +
        `of reflecting any origin.`,
    );
  }
}
