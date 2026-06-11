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
    },
    logging: {
      level: optionalString(env.LOG_LEVEL) ?? CONFIG_DEFAULTS.logLevel,
      pretty: !isDeployedProfile,
    },
    persistence: {
      databaseUrl: optionalString(env.DATABASE_URL),
    },
  };

  return { [CONFIG_NAMESPACE]: config };
}
