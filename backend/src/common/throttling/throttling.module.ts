import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";

import { AppConfigService } from "../../config/app-config.service";
import { AppConfigModule } from "../../config/config.module";

/** Limiter protecting administrative token issuance from brute force. */
export const AUTH_THROTTLER = "auth";
/** Limiter protecting the RPC endpoint from read amplification. */
export const POLICIES_THROTTLER = "policies";

/**
 * Single registration of every named rate limiter.
 *
 * `ThrottlerModule.forRoot` configures one global set of throttlers. Registering
 * it separately per feature module does not give each module its own limiter —
 * the later registration wins and silently replaces the earlier one's limits.
 * Declaring both here keeps each feature's budget intact, and routes opt out of
 * the limiters that do not apply to them with `@SkipThrottle`.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => [
        {
          name: AUTH_THROTTLER,
          // Throttler expects milliseconds; configuration exposes seconds.
          ttl: config.auth.rateLimitTtlSeconds * 1000,
          limit: config.auth.rateLimitMax,
        },
        {
          name: POLICIES_THROTTLER,
          ttl: config.blockchain.readRateLimitTtlSeconds * 1000,
          limit: config.blockchain.readRateLimitMax,
        },
      ],
    }),
  ],
  exports: [ThrottlerModule],
})
export class ThrottlingModule {}
