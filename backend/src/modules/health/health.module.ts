import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";

import { BlockchainModule } from "../blockchain/blockchain.module";
import { HealthController } from "./health.controller";
import { ChainHealthIndicator } from "./indicators/chain.health";
import { ConfigHealthIndicator } from "./indicators/config.health";
import { ContractRegistryHealthIndicator } from "./indicators/contract-registry.health";

/**
 * Exposes liveness (`GET /health`) and readiness (`GET /health/ready`) probes.
 * Readiness aggregates configuration posture, on-chain metadata health, and
 * live chain reachability.
 */
@Module({
  imports: [TerminusModule, BlockchainModule],
  controllers: [HealthController],
  providers: [
    ContractRegistryHealthIndicator,
    ConfigHealthIndicator,
    ChainHealthIndicator,
  ],
})
export class HealthModule {}
