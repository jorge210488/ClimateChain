import { Module } from "@nestjs/common";

import { ThrottlingModule } from "../../common/throttling/throttling.module";
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
 *
 * The rate limiter here protects the node rather than the API: a single list
 * request fans out into a dozen RPC calls per policy returned, so unmetered
 * public reads let a caller amplify modest HTTP traffic into a load the RPC
 * endpoint answers for. Providers meter by request, so the cost is real.
 */
@Module({
  imports: [BlockchainModule, ThrottlingModule],
  controllers: [PoliciesController],
  providers: [PoliciesService, PolicyChainService],
  exports: [PolicyChainService],
})
export class PoliciesModule {}
