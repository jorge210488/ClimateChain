import { Injectable } from "@nestjs/common";
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from "@nestjs/terminus";

import { AppConfigService } from "../../../config/app-config.service";
import { ChainBootstrapService } from "../../blockchain/chain-bootstrap.service";
import { ChainProviderService } from "../../blockchain/chain-provider.service";

/**
 * Readiness indicator for live chain access.
 *
 * Boot verification proves the chain was correct at startup; it says nothing
 * about now. A node can go down, fall behind, or be swapped underneath a
 * long-running process, so this probe issues a real call on every check rather
 * than reporting a cached verdict.
 *
 * As with the other indicators, deployed profiles expose only the verdict:
 * block heights, reserve balances, and the signer address are useful locally
 * and are reconnaissance material on a public endpoint.
 */
@Injectable()
export class ChainHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly chain: ChainProviderService,
    private readonly bootstrap: ChainBootstrapService,
    private readonly config: AppConfigService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    if (!this.chain.isEnabled()) {
      // A local profile intentionally running without a node is not "broken",
      // but it is not ready to serve policy traffic either, so readiness must
      // fail rather than claiming health the service cannot deliver.
      return indicator.down({
        reason:
          "No RPC endpoint configured; policy operations are unavailable. " +
          "Set RPC_URL to enable chain access.",
      });
    }

    const verification = this.bootstrap.getVerification();
    if (!verification) {
      return indicator.down({
        reason: "Chain verification did not complete at startup",
      });
    }

    try {
      // Both are asked of the node. Reporting the chain id recorded at boot
      // would keep claiming the right chain after RPC_URL was repointed at a
      // different one — precisely the drift this probe should catch.
      const [chainId, blockNumber] = await Promise.all([
        this.chain.getChainIdFromNode(),
        this.chain.call("health.getBlockNumber", () =>
          this.chain.getProvider().getBlockNumber(),
        ),
      ]);

      if (chainId !== verification.chainId) {
        return indicator.down({
          reason:
            `The node now reports chainId=${chainId} but this service was ` +
            `verified against chainId=${verification.chainId} at startup. The ` +
            `RPC endpoint points at a different chain than the deployed contracts.`,
        });
      }

      if (this.config.isDeployedProfile) {
        return indicator.up({ chainId: verification.chainId });
      }

      return indicator.up({
        chainId: verification.chainId,
        blockNumber,
        providerAddress: verification.providerAddress,
        oracleAddress: verification.oracleAddress,
        signerAddress: verification.signerAddress,
        signerConfigured: this.chain.hasSigner(),
        coverageReserveWei: verification.coverageReserveWei,
        verifiedAt: verification.verifiedAt,
      });
    } catch (error) {
      return indicator.down({
        reason: `RPC endpoint is not responding: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
}
