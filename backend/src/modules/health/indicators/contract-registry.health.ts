import { Injectable } from "@nestjs/common";
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from "@nestjs/terminus";

import { ContractRegistryService } from "../../blockchain/contract-registry.service";

/**
 * Readiness indicator asserting the on-chain integration metadata (ABIs +
 * deployment manifest) is loaded and coherent. This is the critical runtime
 * dependency owned by Stage 05.
 */
@Injectable()
export class ContractRegistryHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly registry: ContractRegistryService,
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
    return indicator.up({
      network: snapshot.network,
      chainId: snapshot.chainId,
      providerAddress: snapshot.providerAddress,
      providerAddressSource: snapshot.providerAddressSource,
      loadedContracts: snapshot.loadedContracts,
    });
  }
}
