import { Module } from "@nestjs/common";

import { BlockchainController } from "./blockchain.controller";
import { ContractRegistryService } from "./contract-registry.service";

/**
 * Owns the on-chain integration metadata contract.
 *
 * Stage 05 scope: load and validate ABIs + deployment manifests and expose
 * them to the rest of the application. Stage 06 extends this module with the
 * live ethers client built from the exported registry.
 */
@Module({
  controllers: [BlockchainController],
  providers: [ContractRegistryService],
  exports: [ContractRegistryService],
})
export class BlockchainModule {}
