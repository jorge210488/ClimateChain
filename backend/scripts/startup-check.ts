/**
 * Stage 05 startup smoke check.
 *
 * Boots the full application through the same wiring as production
 * (`configureApp` + `setupSwagger`), exercising fail-fast config + ABI/manifest
 * validation, the pino logger, shared HTTP config, and Swagger. Probes the
 * liveness, readiness, deployment, and docs endpoints. Exits non-zero on any
 * failure so it can gate releases in CI.
 */
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp, setupSwagger } from "../src/app-setup";

const PROBES = [
  "/health",
  "/health/ready",
  "/blockchain/deployment",
  "/docs",
  "/docs-json",
];

async function main(): Promise<void> {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(AppModule, { bufferLogs: true });
    configureApp(app);
    setupSwagger(app);
    await app.init();

    const server = app.getHttpServer();
    for (const path of PROBES) {
      const response = await request(server).get(path);
      if (response.status !== 200) {
        throw new Error(
          `GET ${path} returned ${response.status}: ${JSON.stringify(response.body)}`,
        );
      }
      console.log(`startup-check OK: GET ${path} -> 200`);
    }
  } finally {
    await app?.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      "startup-check FAILED:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
