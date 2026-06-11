import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";

import { AppConfigService } from "../config/app-config.service";
import { AppConfigModule } from "../config/config.module";

/**
 * Structured logging foundation built on pino.
 *
 * - Emits JSON logs in deployed profiles and pretty logs locally.
 * - Correlates every request with an `x-request-id` (honoring an inbound
 *   header when present) echoed back on the response.
 * - Redacts sensitive headers and credential-bearing body fields.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        const { level, pretty } = config.logging;

        return {
          pinoHttp: {
            level,
            genReqId: (req: IncomingMessage, res: ServerResponse) => {
              const header = req.headers["x-request-id"];
              const inbound = Array.isArray(header) ? header[0] : header;
              const requestId =
                inbound && inbound.length > 0 ? inbound : randomUUID();
              res.setHeader("x-request-id", requestId);
              return requestId;
            },
            customProps: () => ({ service: "climatechain-backend" }),
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.body.apiKey",
                "req.body.privateKey",
                "req.body.password",
              ],
              remove: true,
            },
            autoLogging: true,
            transport: pretty
              ? {
                  target: "pino-pretty",
                  options: {
                    singleLine: true,
                    translateTime: "SYS:standard",
                    ignore: "pid,hostname",
                  },
                }
              : undefined,
          },
        };
      },
    }),
  ],
})
export class AppLoggerModule {}
