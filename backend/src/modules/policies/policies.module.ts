import { Module } from "@nestjs/common";

import { PoliciesController } from "./policies.controller";
import { PoliciesService } from "./policies.service";

/**
 * Policy lifecycle module.
 *
 * Stage 05 owns the request/response contracts and validation. Stage 06 imports
 * the blockchain client here to execute creation and reads against the deployed
 * `InsuranceProvider`/`InsurancePolicy` contracts.
 */
@Module({
  controllers: [PoliciesController],
  providers: [PoliciesService],
})
export class PoliciesModule {}
