import { Module } from "@nestjs/common";
import { JwtModule, JwtSignOptions } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";

import { ThrottlingModule } from "../../common/throttling/throttling.module";
import { AppConfigService } from "../../config/app-config.service";
import { AppConfigModule } from "../../config/config.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";

/**
 * Authentication foundation: registers the JWT passport strategy, the
 * administrative token-issuance flow, and the rate limiter protecting it. The
 * global JWT and roles guards are wired in {@link AppModule} so protection
 * applies across every module.
 *
 * The limiter is scoped to this module rather than registered globally: it
 * exists to make `ADMIN_API_KEY` infeasible to brute-force, and blanket
 * throttling of every route is a Stage 13 decision with its own budget.
 */
@Module({
  imports: [
    PassportModule,
    ThrottlingModule,
    JwtModule.registerAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.auth.jwtSecret,
        signOptions: {
          expiresIn: config.auth.jwtExpiresIn as JwtSignOptions["expiresIn"],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
