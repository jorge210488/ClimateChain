import { Module, ValidationPipe } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_PIPE } from "@nestjs/core";

import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { AppConfigModule } from "./config/config.module";
import { AppLoggerModule } from "./logging/logger.module";
import { AuthModule } from "./modules/auth/auth.module";
import { JwtAuthGuard } from "./modules/auth/guards/jwt-auth.guard";
import { RolesGuard } from "./modules/auth/guards/roles.guard";
import { BlockchainModule } from "./modules/blockchain/blockchain.module";
import { HealthModule } from "./modules/health/health.module";
import { PoliciesModule } from "./modules/policies/policies.module";
import { PricingModule } from "./modules/pricing/pricing.module";

/**
 * Application root.
 *
 * Global cross-cutting providers are registered here so they apply uniformly
 * across every module and in tests:
 * - `APP_PIPE`: strict validation (whitelist + reject unknown + transform).
 * - `APP_FILTER`: canonical error-contract exception filter.
 * - `APP_GUARD`: JWT authentication, then role-based authorization.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    BlockchainModule,
    HealthModule,
    AuthModule,
    PoliciesModule,
    PricingModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
