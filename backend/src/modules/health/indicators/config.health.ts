import { Injectable } from "@nestjs/common";
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from "@nestjs/terminus";

import { AppConfigService } from "../../../config/app-config.service";

/**
 * Readiness indicator reporting the resolved configuration posture and
 * enforcing profile-specific requirements.
 *
 * For deployed profiles (staging/testnet/production) a real RPC endpoint must
 * be configured; otherwise the indicator reports down with an actionable
 * reason. Local/test/dev profiles treat the live integrations as optional
 * since they are wired in later stages.
 */
@Injectable()
export class ConfigHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly config: AppConfigService,
  ) {}

  isHealthy(key: string): HealthIndicatorResult {
    const indicator = this.healthIndicatorService.check(key);
    const { app, blockchain, mlService, auth } = this.config;

    const details = {
      profile: app.nodeEnv,
      blockchainNetwork: blockchain.network,
      rpcConfigured: Boolean(blockchain.rpcUrl),
      signerConfigured: Boolean(blockchain.privateKey),
      mlServiceConfigured: Boolean(mlService.baseUrl),
      adminTokenEndpointEnabled: Boolean(auth.adminApiKey),
    };

    if (app.isDeployedProfile && !blockchain.rpcUrl) {
      return indicator.down({
        ...details,
        reason: "RPC_URL must be configured for deployed profiles",
      });
    }

    return indicator.up(details);
  }
}
