import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";

import { BlockchainModule } from "../blockchain/blockchain.module";
import { HealthController } from "./health.controller";
import { ConfigHealthIndicator } from "./indicators/config.health";
import { ContractRegistryHealthIndicator } from "./indicators/contract-registry.health";

/**
 * Exposes liveness (`GET /health`) and readiness (`GET /health/ready`) probes.
 * Readiness aggregates configuration posture and on-chain metadata health.
 */
@Module({
  imports: [TerminusModule, BlockchainModule],
  controllers: [HealthController],
  providers: [ContractRegistryHealthIndicator, ConfigHealthIndicator],
})
export class HealthModule {}
