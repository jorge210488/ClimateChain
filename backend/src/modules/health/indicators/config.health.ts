import { Injectable } from "@nestjs/common";
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from "@nestjs/terminus";

import { AppConfigService } from "../../../config/app-config.service";

/**
 * Readiness indicator reporting configuration posture and enforcing
 * profile-specific requirements.
 *
 * For deployed profiles (staging/testnet/production) a real RPC endpoint must
 * be configured. That requirement is enforced at boot (config schema plus the
 * deployed-profile invariants in `configuration.ts`), so this check is defense
 * in depth for a runtime that somehow started without it rather than the
 * primary gate. To limit reconnaissance surface on the anonymous readiness probe,
 * deployed profiles expose only minimal detail, while local/dev/test expose the
 * full posture for developer diagnostics.
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

    if (app.isDeployedProfile && !blockchain.rpcUrl) {
      return indicator.down({
        profile: app.nodeEnv,
        reason: "RPC_URL must be configured for deployed profiles",
      });
    }

    if (app.isDeployedProfile) {
      return indicator.up({ profile: app.nodeEnv });
    }

    return indicator.up({
      profile: app.nodeEnv,
      blockchainNetwork: blockchain.network,
      rpcConfigured: Boolean(blockchain.rpcUrl),
      signerConfigured: Boolean(blockchain.privateKey),
      mlServiceConfigured: Boolean(mlService.baseUrl),
      adminTokenEndpointEnabled: Boolean(auth.adminApiKey),
    });
  }
}
