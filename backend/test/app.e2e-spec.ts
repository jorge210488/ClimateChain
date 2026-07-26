import "reflect-metadata";

import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp, HTTP_APP_OPTIONS, setupSwagger } from "../src/app-setup";

const VALID_ADDRESS = "0x1111111111111111111111111111111111111111";
/** Must satisfy the 32-character ADMIN_API_KEY minimum enforced at boot. */
const ADMIN_API_KEY = "e2e-admin-api-key-0123456789abcdef";
/**
 * Small limits so the throttling tests stay fast and deterministic.
 *
 * The policy budget must exceed the number of policy requests the rest of this
 * suite makes, or those tests would exhaust it and fail on 429 instead of the
 * behavior they assert.
 */
const AUTH_RATE_LIMIT_MAX = 5;
const POLICY_READ_LIMIT = 30;

describe("ClimateChain backend (e2e)", () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let bearer: string;

  /** POST /policies requires an authenticated principal. */
  const createPolicy = () =>
    request(app.getHttpServer()).post("/policies").set("Authorization", bearer);

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.LOG_LEVEL = "silent";
    // This suite asserts the no-chain contract, so it must not inherit chain
    // configuration from a suite that ran earlier in the same process. Without
    // this, results depend on file ordering rather than on the code.
    delete process.env.RPC_URL;
    delete process.env.PRIVATE_KEY;
    delete process.env.CHAIN_ID;
    delete process.env.BLOCKCHAIN_NETWORK;
    process.env.ADMIN_API_KEY = ADMIN_API_KEY;
    process.env.AUTH_RATE_LIMIT_MAX = String(AUTH_RATE_LIMIT_MAX);
    process.env.CHAIN_READ_RATE_LIMIT_MAX = String(POLICY_READ_LIMIT);
    process.env.JWT_SECRET = "e2e-test-jwt-secret-0123456789";

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication(HTTP_APP_OPTIONS);
    // Exercise the same wiring as production bootstrap.
    configureApp(app);
    setupSwagger(app);
    await app.init();
    jwtService = app.get(JwtService, { strict: false });
    bearer = `Bearer ${jwtService.sign({ sub: "admin", roles: ["admin"] })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  describe("health", () => {
    it("GET /health -> 200 ok", async () => {
      const res = await request(app.getHttpServer()).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });

    it("GET /health/ready -> 503 while no chain is configured", async () => {
      // This suite runs without RPC_URL on purpose, which is the degraded
      // state readiness must report honestly: config and metadata are fine,
      // but the service cannot serve policy traffic without a chain.
      const res = await request(app.getHttpServer()).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.info["contract-registry"].status).toBe("up");
      expect(res.body.info.config.status).toBe("up");
      expect(res.body.error.chain.status).toBe("down");
      expect(res.body.error.chain.reason).toContain("RPC_URL");
    });
  });

  describe("blockchain", () => {
    it("GET /blockchain/deployment returns loaded integration metadata", async () => {
      const res = await request(app.getHttpServer()).get(
        "/blockchain/deployment",
      );
      expect(res.status).toBe(200);
      expect(res.body.network).toBe("hardhat");
      expect(res.body.chainId).toBe("31337");
      expect(res.body.providerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(res.body.loadedContracts).toEqual(
        expect.arrayContaining(["InsuranceProvider", "InsurancePolicy"]),
      );
      // Non-deployed (test) profile exposes the provenance detail.
      expect(res.body.providerAddressSource).toBe("manifest");
    });
  });

  describe("security headers", () => {
    it("sets helmet baseline headers", async () => {
      const res = await request(app.getHttpServer()).get("/health");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBeDefined();
      // helmet removes the framework fingerprint.
      expect(res.headers["x-powered-by"]).toBeUndefined();
    });
  });

  describe("docs", () => {
    it("GET /docs -> 200 (Swagger UI)", async () => {
      const res = await request(app.getHttpServer()).get("/docs");
      expect(res.status).toBe(200);
    });

    it("GET /docs-json -> 200 (OpenAPI document)", async () => {
      const res = await request(app.getHttpServer()).get("/docs-json");
      expect(res.status).toBe(200);
      expect(res.body.openapi).toBeDefined();
      expect(res.body.paths["/health"]).toBeDefined();
    });
  });

  describe("policies", () => {
    it("rejects an anonymous create with 401", async () => {
      // Creation draws on the provider's coverage reserve from Stage 06, so it
      // must never be reachable without an authenticated principal.
      const res = await request(app.getHttpServer()).post("/policies").send({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        region: "Valencia",
      });
      expect(res.status).toBe(401);
    });

    it("rejects a create with a malformed bearer token", async () => {
      const res = await request(app.getHttpServer())
        .post("/policies")
        .set("Authorization", "Bearer not-a-real-token")
        .send({
          coverageEth: "1.0",
          premiumEth: "0.05",
          rainfallThresholdMm: 50,
          durationDays: 30,
          region: "Valencia",
        });
      expect(res.status).toBe(401);
    });

    it("keeps reads public", async () => {
      // On-chain state is world-readable, so gating reads adds friction
      // without adding confidentiality. 503 (not 401) proves the request
      // reached the handler rather than being rejected by the auth guard.
      const list = await request(app.getHttpServer()).get("/policies");
      expect(list.status).toBe(503);

      const byAddress = await request(app.getHttpServer()).get(
        `/policies/${VALID_ADDRESS}`,
      );
      expect(byAddress.status).toBe(503);
    });

    it("accepts a checksummed insured filter regardless of casing", async () => {
      const mixedCase = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
      const res = await request(app.getHttpServer())
        .get("/policies")
        .query({ insured: mixedCase });
      // Reaches the handler (503) rather than failing validation (400).
      expect(res.status).toBe(503);
    });

    it("rejects a malformed insured filter with 400", async () => {
      const res = await request(app.getHttpServer())
        .get("/policies")
        .query({ insured: "0xnope" });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain("insured");
    });

    it("rejects an oversized request body", async () => {
      const res = await createPolicy().send({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        region: "x".repeat(200_000),
      });
      expect(res.status).toBe(413);
    });

    it("rejects an invalid create body with 400 and the error contract", async () => {
      const res = await createPolicy().send({
        coverageEth: "0",
        premiumEth: "abc",
        rainfallThresholdMm: 0,
        durationDays: 9999,
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        error: "Bad Request",
        method: "POST",
        path: "/policies",
      });
      expect(Array.isArray(res.body.message)).toBe(true);
      expect(typeof res.body.timestamp).toBe("string");
    });

    it("rejects unknown properties via the whitelist", async () => {
      const res = await createPolicy().send({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        unexpectedField: true,
      });
      expect(res.status).toBe(400);
    });

    it("reports 503 for a valid create while the chain is unreachable", async () => {
      const res = await createPolicy().send({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        region: "Valencia",
      });
      expect(res.status).toBe(503);
      expect(res.body.message).toContain("RPC_URL");
    });

    it("rejects a premium below the on-chain minimum (1% of coverage)", async () => {
      const res = await createPolicy().send({
        coverageEth: "1.0",
        premiumEth: "0.005", // 0.5% < 1% minimum
        rainfallThresholdMm: 50,
        durationDays: 30,
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain("premiumEth");
    });

    it("rejects a region exceeding 31 UTF-8 bytes (multibyte)", async () => {
      const res = await createPolicy().send({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        region: "ñ".repeat(16), // 16 chars but 32 UTF-8 bytes
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain("region");
    });

    it("rejects a requestedStartTimestamp inside the lead-time window", async () => {
      const tooSoon = Math.floor(Date.now() / 1000) + 5; // < 60s lead time
      const res = await createPolicy().send({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        requestedStartTimestamp: tooSoon,
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain(
        "requestedStartTimestamp",
      );
    });

    it("accepts a requestedStartTimestamp with region beyond the lead-time window (-> 503)", async () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      const res = await createPolicy().send({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        region: "Valencia",
        requestedStartTimestamp: future,
      });
      expect(res.status).toBe(503);
    });

    it("rejects a requestedStartTimestamp without a region", async () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      const res = await createPolicy().send({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        requestedStartTimestamp: future,
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain(
        "requestedStartTimestamp",
      );
    });

    it("rejects an empty region string", async () => {
      const res = await createPolicy().send({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        region: "",
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain("region");
    });

    it("rejects an invalid policy address with 400", async () => {
      const res = await request(app.getHttpServer()).get(
        "/policies/not-an-address",
      );
      expect(res.status).toBe(400);
    });

    it("reports 503 for a valid policy address lookup without a chain", async () => {
      const res = await request(app.getHttpServer()).get(
        `/policies/${VALID_ADDRESS}`,
      );
      expect(res.status).toBe(503);
    });

    // Declared last: the limiter counts every policy request made above, so
    // running this earlier would starve the preceding tests of their budget.
    it("throttles the public read endpoints independently of auth", async () => {
      // These reads are anonymous and each fans out into many RPC calls, so an
      // unmetered endpoint lets a caller amplify HTTP traffic into RPC load.
      // The budgets are separate: exhausting the read limiter must not consume
      // the credential-guarding one.
      const statuses: number[] = [];
      for (let attempt = 0; attempt < POLICY_READ_LIMIT + 3; attempt += 1) {
        const res = await request(app.getHttpServer()).get("/policies");
        statuses.push(res.status);
      }

      expect(statuses).toContain(429);
      expect(statuses[statuses.length - 1]).toBe(429);

      const tokenRes = await request(app.getHttpServer())
        .post("/auth/token")
        .send({ apiKey: ADMIN_API_KEY });
      expect(tokenRes.status).not.toBe(429);
    });
  });

  describe("pricing", () => {
    it("rejects an invalid quote with 400", async () => {
      const res = await request(app.getHttpServer())
        .post("/pricing/quote")
        .send({
          region: "",
          startDate: "not-a-date",
          endDate: "2026-04-30",
          coverageEth: "1.0",
          rainfallThresholdMm: 50,
        });
      expect(res.status).toBe(400);
    });

    it("rejects a quote whose endDate precedes startDate", async () => {
      const res = await request(app.getHttpServer())
        .post("/pricing/quote")
        .send({
          region: "Valencia",
          startDate: "2026-04-30",
          endDate: "2026-04-01",
          coverageEth: "1.0",
          rainfallThresholdMm: 50,
        });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain("endDate");
    });

    it("rejects a quote region exceeding the on-chain byte budget", async () => {
      const res = await request(app.getHttpServer())
        .post("/pricing/quote")
        .send({
          region: "x".repeat(32), // 32 bytes > 31-byte bytes32 budget
          startDate: "2026-04-01",
          endDate: "2026-04-30",
          coverageEth: "1.0",
          rainfallThresholdMm: 50,
        });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain("region");
    });

    it("returns 501 for a valid quote (live integration arrives in Stage 09)", async () => {
      const res = await request(app.getHttpServer())
        .post("/pricing/quote")
        .send({
          region: "Valencia",
          startDate: "2026-04-01",
          endDate: "2026-04-30",
          coverageEth: "1.0",
          rainfallThresholdMm: 50,
        });
      // Pricing is still Stage 09: unlike the policy paths, this is a
      // not-yet-implemented capability, not a degraded dependency.
      expect(res.status).toBe(501);
      expect(res.body.message).toContain("Stage 09");
    });
  });

  describe("auth", () => {
    it("GET /auth/me without a token -> 401", async () => {
      const res = await request(app.getHttpServer()).get("/auth/me");
      expect(res.status).toBe(401);
    });

    it("POST /auth/token with a wrong key -> 401", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/token")
        .send({ apiKey: "wrong-key" });
      expect(res.status).toBe(401);
    });

    it("issues a token and authorizes /auth/me for an admin principal", async () => {
      const tokenRes = await request(app.getHttpServer())
        .post("/auth/token")
        .send({ apiKey: ADMIN_API_KEY });
      expect(tokenRes.status).toBe(200);
      const token = tokenRes.body.accessToken as string;
      expect(typeof token).toBe("string");

      const meRes = await request(app.getHttpServer())
        .get("/auth/me")
        .set("Authorization", `Bearer ${token}`);
      expect(meRes.status).toBe(200);
      expect(meRes.body).toEqual({ userId: "admin", roles: ["admin"] });
    });

    it("forbids /auth/me for a non-admin token -> 403", async () => {
      const token = jwtService.sign({ sub: "user", roles: [] });
      const res = await request(app.getHttpServer())
        .get("/auth/me")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    // Declared last: the limiter counts every /auth/token call made above, so
    // running this first would starve the preceding tests of their budget.
    it("throttles repeated token-issuance attempts with 429", async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < AUTH_RATE_LIMIT_MAX + 2; attempt += 1) {
        const res = await request(app.getHttpServer())
          .post("/auth/token")
          .send({ apiKey: "brute-force-guess" });
        statuses.push(res.status);
      }

      expect(statuses).toContain(429);
      // Once throttled, further attempts stay throttled within the window.
      expect(statuses[statuses.length - 1]).toBe(429);
    });
  });
});
