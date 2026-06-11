import { Module } from "@nestjs/common";

import { PricingController } from "./pricing.controller";
import { PricingService } from "./pricing.service";

/**
 * Premium pricing module.
 *
 * Stage 05 owns the quote request/response contract and validation. Stage 09
 * adds the HTTP client to the Python ML service to fulfill quotes.
 */
@Module({
  controllers: [PricingController],
  providers: [PricingService],
})
export class PricingModule {}
