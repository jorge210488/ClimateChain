import { Module } from "@nestjs/common";

import { BlockchainController } from "./blockchain.controller";
import { ChainBootstrapService } from "./chain-bootstrap.service";
import { ChainProviderService } from "./chain-provider.service";
import { ContractFactoryService } from "./contract-factory.service";
import { ContractRegistryService } from "./contract-registry.service";

/**
 * Owns everything between the backend and the chain.
 *
 * Stage 05 established the metadata contract (ABIs + deployment manifests).
 * Stage 06 adds the live client on top of it: the RPC connection and signer,
 * contract instances built from the registry's ABIs, and boot-time verification
 * that the configured chain matches what the backend assumes.
 *
 * Exports are the seam other modules build on; nothing outside this module
 * constructs a provider, a signer, or a contract instance of its own.
 */
@Module({
  controllers: [BlockchainController],
  providers: [
    ContractRegistryService,
    ChainProviderService,
    ContractFactoryService,
    ChainBootstrapService,
  ],
  exports: [
    ContractRegistryService,
    ChainProviderService,
    ContractFactoryService,
    ChainBootstrapService,
  ],
})
export class BlockchainModule {}
