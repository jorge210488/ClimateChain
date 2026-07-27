import { Global, Module } from "@nestjs/common";

import { IdempotencyService } from "./idempotency.service";

/**
 * Provides replay protection for non-idempotent operations.
 *
 * Global because the store must be one instance: a per-module provider would
 * give each module its own map, and two modules would then not see each other's
 * keys.
 */
@Global()
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
