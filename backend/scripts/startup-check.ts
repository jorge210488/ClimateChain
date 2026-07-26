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
import { configureApp, HTTP_APP_OPTIONS, setupSwagger } from "../src/app-setup";

/**
 * Probes and the statuses each may legitimately return.
 *
 * Readiness accepts 503 as well as 200 because it now aggregates live chain
 * reachability: without RPC_URL the service is genuinely not ready to serve
 * policy traffic, and reporting otherwise would be a lie. The check still
 * verifies the *reason*, so a 503 caused by anything other than a deliberately
 * absent chain fails the gate.
 */
const PROBES: { path: string; accepted: number[] }[] = [
  { path: "/health", accepted: [200] },
  { path: "/health/ready", accepted: [200, 503] },
  { path: "/blockchain/deployment", accepted: [200] },
  { path: "/docs", accepted: [200] },
  { path: "/docs-json", accepted: [200] },
];

async function main(): Promise<void> {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(AppModule, HTTP_APP_OPTIONS);
    configureApp(app);
    setupSwagger(app);
    await app.init();

    const server = app.getHttpServer();
    for (const { path, accepted } of PROBES) {
      const response = await request(server).get(path);
      if (!accepted.includes(response.status)) {
        throw new Error(
          `GET ${path} returned ${response.status} (accepted: ${accepted.join(
            ", ",
          )}): ${JSON.stringify(response.body)}`,
        );
      }

      if (path === "/health/ready" && response.status === 503) {
        assertReadinessDegradedOnlyByChain(response.body);
      }

      console.log(`startup-check OK: GET ${path} -> ${response.status}`);
    }
  } finally {
    await app?.close();
  }
}

/**
 * Accepts a degraded readiness result only when the sole failing dependency is
 * the chain and the reason is a deliberately absent RPC endpoint. Anything else
 * — a broken registry, an unreachable but configured node — is a real failure
 * and must not pass as "expected degradation".
 */
function assertReadinessDegradedOnlyByChain(body: unknown): void {
  const errors =
    (body as { error?: Record<string, { status?: string; reason?: string }> })
      ?.error ?? {};
  const failing = Object.keys(errors);

  if (failing.length !== 1 || failing[0] !== "chain") {
    throw new Error(
      `Readiness is degraded by unexpected dependencies [${failing.join(", ")}]: ` +
        JSON.stringify(body),
    );
  }

  const reason = errors.chain?.reason ?? "";
  if (!reason.includes("RPC_URL")) {
    throw new Error(
      `Chain readiness failed for an unexpected reason: ${reason}`,
    );
  }

  console.log(
    "startup-check note: chain dependency is intentionally absent " +
      "(no RPC_URL configured); readiness correctly reports 503.",
  );
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
