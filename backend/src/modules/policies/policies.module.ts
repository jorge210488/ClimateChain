import { Module } from "@nestjs/common";

import { BlockchainModule } from "../blockchain/blockchain.module";
import { PoliciesController } from "./policies.controller";
import { PoliciesService } from "./policies.service";
import { PolicyChainService } from "./policy-chain.service";

/**
 * Policy lifecycle module.
 *
 * Owns the request/response contracts, validation, and the domain-level chain
 * access that executes creation and reads against the deployed
 * `InsuranceProvider` / `InsurancePolicy` contracts.
 */
@Module({
  imports: [BlockchainModule],
  controllers: [PoliciesController],
  providers: [PoliciesService, PolicyChainService],
  exports: [PolicyChainService],
})
export class PoliciesModule {}
