import { RuntimeProfile } from "./config.defaults";

export interface AppRuntimeConfig {
  nodeEnv: RuntimeProfile;
  port: number;
  /** True for staging/testnet/production profiles. */
  isDeployedProfile: boolean;
}

export interface BlockchainConfig {
  /** Network key used to resolve `contracts/deployments/<network>.json`. */
  network: string;
  /** Optional expected chain id; cross-checked against the deployment manifest when set. */
  chainId?: number;
  /** JSON-RPC endpoint. Optional at Stage 05, required from Stage 06 (live integration). */
  rpcUrl?: string;
  /** Signer private key. Optional at Stage 05, required from Stage 06 (live integration). */
  privateKey?: string;
  /** Optional explicit provider/factory address override (otherwise taken from manifest). */
  factoryAddress?: string;
  /** Absolute directory containing the shared ABI bundle. */
  sharedAbiDir: string;
  /** Absolute directory containing per-network deployment manifests. */
  deploymentsDir: string;
}

export interface MlServiceConfig {
  baseUrl: string;
  timeoutMs: number;
}

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  /** When set, enables the administrative token-issuance endpoint. */
  adminApiKey?: string;
}

export interface LoggingConfig {
  level: string;
  /** Pretty transport is enabled for non-deployed profiles for developer ergonomics. */
  pretty: boolean;
}

export interface PersistenceConfig {
  /** Reserved for the optional Stage 11 off-chain persistence layer. */
  databaseUrl?: string;
}

export interface RootConfig {
  app: AppRuntimeConfig;
  blockchain: BlockchainConfig;
  mlService: MlServiceConfig;
  auth: AuthConfig;
  logging: LoggingConfig;
  persistence: PersistenceConfig;
}

/** Top-level configuration namespace key registered with `@nestjs/config`. */
export const CONFIG_NAMESPACE = "climatechain";
