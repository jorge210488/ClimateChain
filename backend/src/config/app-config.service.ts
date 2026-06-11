import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import {
  AppRuntimeConfig,
  AuthConfig,
  BlockchainConfig,
  CONFIG_NAMESPACE,
  LoggingConfig,
  MlServiceConfig,
  PersistenceConfig,
  RootConfig,
} from "./config.types";

/**
 * Strongly typed accessor over the validated configuration namespace.
 *
 * Every module depends on this service instead of reading `process.env`
 * directly, keeping configuration access centralized and type-safe.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  private get root(): RootConfig {
    return this.configService.getOrThrow<RootConfig>(CONFIG_NAMESPACE);
  }

  get app(): AppRuntimeConfig {
    return this.root.app;
  }

  get blockchain(): BlockchainConfig {
    return this.root.blockchain;
  }

  get mlService(): MlServiceConfig {
    return this.root.mlService;
  }

  get auth(): AuthConfig {
    return this.root.auth;
  }

  get logging(): LoggingConfig {
    return this.root.logging;
  }

  get persistence(): PersistenceConfig {
    return this.root.persistence;
  }

  /** True for staging/testnet/production runtime profiles. */
  get isDeployedProfile(): boolean {
    return this.root.app.isDeployedProfile;
  }
}
