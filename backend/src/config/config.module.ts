import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { AppConfigService } from "./app-config.service";
import { configuration } from "./configuration";
import { envValidationSchema } from "./env.validation";

/**
 * Global configuration module.
 *
 * - Validates the environment with a fail-fast Joi schema.
 * - Loads a typed configuration namespace consumed via {@link AppConfigService}.
 * - Ignores `.env` files under the `test` profile so test runs stay
 *   deterministic and driven purely by injected `process.env` values.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
      ignoreEnvFile: process.env.NODE_ENV === "test",
      envFilePath: [".env"],
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
