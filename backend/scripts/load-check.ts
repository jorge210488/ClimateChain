/**
 * Concurrency and load harness for the chain integration.
 *
 * The unit and e2e suites prove the integration is *correct*; this proves it
 * still behaves under simultaneous traffic, which is where the chain client's
 * design decisions actually get tested: nonce ordering under concurrent writes,
 * bounded RPC fan-out on list reads, and the read limiter.
 *
 * Correctness assertions fail the run. Latency is reported, never asserted —
 * timings depend on the machine and the node, so a threshold here would be
 * noise rather than signal.
 *
 * Deliberately not part of the stage gate: it takes minutes and submits many
 * transactions. Run it when the chain client changes.
 *
 *   cd contracts && npx hardhat node
 *   cd contracts && npm run deploy:localhost && npm run reserve:fund:localhost
 *   cd backend   && npm run load:check
 */
import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { NestFactory } from "@nestjs/core";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp, HTTP_APP_OPTIONS } from "../src/app-setup";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const SIGNER_KEY =
  process.env.PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Concurrent policy creations issued in one burst. */
const WRITE_CONCURRENCY = Number(process.env.LOAD_WRITES ?? 10);
/** Concurrent list reads issued in one burst. */
const READ_CONCURRENCY = Number(process.env.LOAD_READS ?? 40);
/** Page size requested by the read burst, to exercise fan-out. */
const READ_PAGE_SIZE = Number(process.env.LOAD_READ_PAGE ?? 25);

interface Timing {
  status: number;
  ms: number;
  body: Record<string, unknown>;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[index];
}

function report(label: string, timings: Timing[]): void {
  const ms = timings.map((t) => t.ms);
  const byStatus = timings.reduce<Record<number, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`\n${label}`);
  console.log(`  requests   ${timings.length}`);
  console.log(
    `  statuses   ${Object.entries(byStatus)
      .map(([status, count]) => `${status}×${count}`)
      .join("  ")}`,
  );
  console.log(
    `  latency    p50 ${percentile(ms, 50)}ms   p95 ${percentile(ms, 95)}ms   max ${Math.max(...ms)}ms`,
  );
}

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  PASS  ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

async function timed(send: () => request.Test): Promise<Timing> {
  const started = Date.now();
  const res = await send();
  return {
    status: res.status,
    ms: Date.now() - started,
    body: res.body as Record<string, unknown>,
  };
}

async function main(): Promise<void> {
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = process.env.LOAD_LOG_LEVEL ?? "warn";
  process.env.RPC_URL = RPC_URL;
  process.env.PRIVATE_KEY = SIGNER_KEY;
  process.env.BLOCKCHAIN_NETWORK =
    process.env.BLOCKCHAIN_NETWORK ?? "localhost";
  process.env.CHAIN_ID = process.env.CHAIN_ID ?? "31337";
  process.env.JWT_SECRET = "load-check-jwt-secret-0123456789";
  // Configuration is read once at boot, so this must be set before the app is
  // created. Sized so the fan-out burst below passes cleanly and the sustained
  // burst that follows it crosses the limit.
  const readLimit = READ_CONCURRENCY + 10;
  process.env.CHAIN_READ_RATE_LIMIT_MAX = String(readLimit);

  let app: INestApplication | undefined;

  try {
    app = await NestFactory.create(AppModule, HTTP_APP_OPTIONS);
    configureApp(app);
    await app.init();

    const server = app.getHttpServer();
    const jwt = app.get(JwtService, { strict: false });
    const bearer = `Bearer ${jwt.sign({ sub: "admin", roles: ["admin"] })}`;

    console.log(
      `Load check against ${RPC_URL} — ${WRITE_CONCURRENCY} concurrent writes, ` +
        `${READ_CONCURRENCY} concurrent reads (page size ${READ_PAGE_SIZE})`,
    );

    // --- Concurrent writes ------------------------------------------------
    // The nonce race lives here: every transaction from one account needs the
    // next sequential nonce, so a burst is what exposes ordering bugs.
    const writes = await Promise.all(
      Array.from({ length: WRITE_CONCURRENCY }, (_unused, i) =>
        timed(() =>
          request(server)
            .post("/policies")
            .set("Authorization", bearer)
            .send({
              coverageEth: "0.01",
              premiumEth: "0.0005",
              rainfallThresholdMm: 20 + i,
              durationDays: 7,
              region: `Load${i}`,
            }),
        ),
      ),
    );
    report("Concurrent policy creation", writes);

    const created = writes.filter((w) => w.status === 201);
    check(
      created.length === WRITE_CONCURRENCY,
      `all ${WRITE_CONCURRENCY} creations succeeded (no nonce collisions)`,
    );
    const addresses = new Set(created.map((w) => String(w.body.address)));
    check(
      addresses.size === created.length,
      "every creation produced a distinct policy address",
    );
    const hashes = new Set(created.map((w) => String(w.body.transactionHash)));
    check(
      hashes.size === created.length,
      "every creation produced a distinct transaction hash",
    );

    // --- Concurrent reads -------------------------------------------------
    // Each policy in a page costs a dozen RPC calls, so this is where an
    // unbounded fan-out would surface as node errors rather than slow responses.
    const reads = await Promise.all(
      Array.from({ length: READ_CONCURRENCY }, () =>
        timed(() =>
          request(server)
            .get("/policies")
            .query({ offset: 0, limit: READ_PAGE_SIZE }),
        ),
      ),
    );
    report("Concurrent list reads", reads);

    check(
      reads.every((r) => r.status === 200),
      `all ${READ_CONCURRENCY} list reads succeeded under fan-out`,
    );
    check(
      reads.every((r) => Array.isArray(r.body.data)),
      "every list read returned a well-formed page",
    );

    // --- Read limiter -----------------------------------------------------
    // The burst above already consumed part of the window, so continuing to
    // read must cross the limit and start shedding.
    const burst: Timing[] = [];
    for (let i = 0; i < readLimit; i += 1) {
      burst.push(await timed(() => request(server).get("/policies")));
    }
    report("Sustained reads against the limiter", burst);
    check(
      burst.some((r) => r.status === 429),
      "the read limiter sheds traffic once the window is exhausted",
    );

    console.log("");
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} load check(s) failed:\n  - ${failures.join("\n  - ")}`,
      );
    }
    console.log("load-check OK: behavior held under concurrent load");
  } finally {
    await app?.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      "load-check FAILED:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
