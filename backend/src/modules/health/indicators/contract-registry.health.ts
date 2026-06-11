import { Injectable } from "@nestjs/common";
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from "@nestjs/terminus";

import { AppConfigService } from "../../../config/app-config.service";
import { ContractRegistryService } from "../../blockchain/contract-registry.service";

/**
 * Readiness indicator asserting the on-chain integration metadata (ABIs +
 * deployment manifest) is loaded and coherent. This is the critical runtime
 * dependency owned by Stage 05.
 *
 * Deployed profiles expose only network/chain id on the anonymous probe; full
 * detail (addresses, loaded contracts) is exposed locally for diagnostics.
 */
@Injectable()
export class ContractRegistryHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly registry: ContractRegistryService,
    private readonly config: AppConfigService,
  ) {}

  isHealthy(key: string): HealthIndicatorResult {
    const indicator = this.healthIndicatorService.check(key);

    if (!this.registry.isReady()) {
      return indicator.down({
        reason:
          "Contract registry metadata is not loaded; check ABI and " +
          "deployment manifest configuration",
      });
    }

    const snapshot = this.registry.getSnapshot();

    if (this.config.isDeployedProfile) {
      return indicator.up({
        network: snapshot.network,
        chainId: snapshot.chainId,
      });
    }

    return indicator.up({
      network: snapshot.network,
      chainId: snapshot.chainId,
      providerAddress: snapshot.providerAddress,
      providerAddressSource: snapshot.providerAddressSource,
      loadedContracts: snapshot.loadedContracts,
    });
  }
}
