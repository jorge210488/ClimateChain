import "reflect-metadata";

import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp, HTTP_APP_OPTIONS } from "../src/app-setup";

/**
 * End-to-end policy lifecycle against a real chain.
 *
 * This is the suite that actually validates Stage 06: it submits real
 * transactions to a real node and reads the resulting state back through the
 * API. It cannot be satisfied by mocks, which is the point — the no-runtime-
 * mocks policy means the integration is only proven by exercising it.
 *
 * Requires a node with the contracts deployed and the coverage reserve funded:
 *
 *   cd contracts && npx hardhat node
 *   cd contracts && npm run deploy:localhost && npm run reserve:fund:localhost
 *   cd backend   && npm run test:e2e:chain
 *
 * Skipped (not failed) when CHAIN_E2E_RPC_URL is absent, so the default gate
 * stays runnable without infrastructure while never silently pretending this
 * ran.
 */

const RPC_URL = process.env.CHAIN_E2E_RPC_URL;
/** Hardhat's first default account; a well-known development key by design. */
const SIGNER_KEY =
  process.env.CHAIN_E2E_PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const NETWORK = process.env.CHAIN_E2E_NETWORK ?? "localhost";
const CHAIN_ID = process.env.CHAIN_E2E_CHAIN_ID ?? "31337";

const ADMIN_API_KEY = "chain-e2e-admin-api-key-0123456789";
const describeChain = RPC_URL ? describe : describe.skip;

if (!RPC_URL) {
  console.warn(
    "[chain e2e] Skipped: set CHAIN_E2E_RPC_URL to run the live-chain suite.",
  );
}

describeChain("ClimateChain policy lifecycle on chain (e2e)", () => {
  let app: INestApplication;
  let bearer: string;
  let createdAddress: string;
  let signerAddress: string;

  jest.setTimeout(120_000);

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    // Overridable so a failing run can be re-executed with real logs, which is
    // the only way to see the cause behind a deliberately generic 500.
    process.env.LOG_LEVEL = process.env.CHAIN_E2E_LOG_LEVEL ?? "silent";
    process.env.BLOCKCHAIN_NETWORK = NETWORK;
    process.env.CHAIN_ID = CHAIN_ID;
    process.env.RPC_URL = RPC_URL;
    process.env.PRIVATE_KEY = SIGNER_KEY;
    process.env.ADMIN_API_KEY = ADMIN_API_KEY;
    process.env.JWT_SECRET = "chain-e2e-jwt-secret-0123456789";

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication(HTTP_APP_OPTIONS);
    configureApp(app);
    await app.init();

    // Boot verification runs on application bootstrap, not module init.
    await app.getHttpAdapter().getInstance();
    const jwt = app.get(JwtService, { strict: false });
    bearer = `Bearer ${jwt.sign({ sub: "admin", roles: ["admin"] })}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe("readiness", () => {
    it("reports the chain as up with live block height", async () => {
      const res = await request(app.getHttpServer()).get("/health/ready");

      expect(res.status).toBe(200);
      expect(res.body.details.chain.status).toBe("up");
      expect(res.body.details.chain.chainId).toBe(CHAIN_ID);
      expect(res.body.details.chain.blockNumber).toBeGreaterThan(0);
      signerAddress = String(
        res.body.details.chain.signerAddress,
      ).toLowerCase();
      expect(signerAddress).toMatch(/^0x[0-9a-f]{40}$/);
    });
  });

  describe("policy creation", () => {
    it("creates a policy and returns its transaction metadata", async () => {
      const res = await request(app.getHttpServer())
        .post("/policies")
        .set("Authorization", bearer)
        .send({
          coverageEth: "0.5",
          premiumEth: "0.02",
          rainfallThresholdMm: 40,
          durationDays: 30,
          region: "ChainE2E",
        });

      expect(res.status).toBe(201);
      expect(res.body.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(res.body.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(res.body.blockNumber).toBeGreaterThan(0);
      expect(Number(res.body.gasUsed)).toBeGreaterThan(0);
      // The contract assigns the insured from msg.sender, so it must be the
      // backend's own signer. Asserting it keeps that consequence visible.
      expect(res.body.insured).toBe(signerAddress);
      expect(res.body.status).toBe("active");

      createdAddress = res.body.address;
    });

    it("creates a policy through the legacy path when no region is given", async () => {
      const res = await request(app.getHttpServer())
        .post("/policies")
        .set("Authorization", bearer)
        .send({
          coverageEth: "0.1",
          premiumEth: "0.005",
          rainfallThresholdMm: 25,
          durationDays: 7,
        });

      expect(res.status).toBe(201);

      const read = await request(app.getHttpServer()).get(
        `/policies/${res.body.address}`,
      );
      expect(read.status).toBe(200);
      // The legacy entry point stores keccak("LEGACY_UNSPECIFIED"), which is
      // not decodable text, so `region` is absent while `regionCode` is not.
      expect(read.body.region).toBeUndefined();
      expect(read.body.regionCode).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("policy reads", () => {
    it("reads back exactly what was written", async () => {
      const res = await request(app.getHttpServer()).get(
        `/policies/${createdAddress}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        address: createdAddress,
        insured: signerAddress,
        status: "active",
        coverageWei: "500000000000000000",
        premiumWei: "20000000000000000",
        rainfallThresholdMm: "40",
        latestRainfallMm: "0",
        pendingPayoutWei: "0",
        conditionMet: false,
        paidOut: false,
        region: "ChainE2E",
        settlementType: "none",
      });
      expect(res.body.endTimestamp - res.body.startTimestamp).toBe(30 * 86_400);
      expect(res.body.oracle).toMatch(/^0x[0-9a-f]{40}$/);
    });

    it("lists policies with on-chain pagination", async () => {
      const res = await request(app.getHttpServer())
        .get("/policies")
        .query({ offset: 0, limit: 1 });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      // Total reflects the provider's full index, not the page size.
      expect(res.body.meta.total).toBeGreaterThanOrEqual(2);
      expect(res.body.meta.limit).toBe(1);
    });

    it("filters by insured account, case-insensitively", async () => {
      const mixedCase = signerAddress.replace("0x", "0X").toUpperCase();
      const res = await request(app.getHttpServer())
        .get("/policies")
        .query({ insured: `0x${mixedCase.slice(2)}` });

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(2);
      for (const policy of res.body.data) {
        expect(policy.insured).toBe(signerAddress);
      }
    });

    it("returns an empty page for an account with no policies", async () => {
      const res = await request(app.getHttpServer())
        .get("/policies")
        .query({ insured: "0x000000000000000000000000000000000000dead" });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    });

    it("returns 404 for an address the provider never created", async () => {
      // Distinguishes "wrong address" from "read failed": without the
      // isPolicyCreated guard this would return zeroed fields as if real.
      const res = await request(app.getHttpServer()).get(
        "/policies/0x1111111111111111111111111111111111111111",
      );

      expect(res.status).toBe(404);
    });
  });

  describe("revert mapping", () => {
    it("maps an over-reserve coverage request to 503 with the on-chain amounts", async () => {
      const res = await request(app.getHttpServer())
        .post("/policies")
        .set("Authorization", bearer)
        .send({
          coverageEth: "1000000",
          premiumEth: "10000",
          rainfallThresholdMm: 50,
          durationDays: 30,
          region: "Valencia",
        });

      expect(res.status).toBe(503);
      expect(res.body.message).toContain("coverage reserve");
      // The decoded arguments are the actionable part of the message.
      expect(res.body.message).toContain("InsufficientCoverageReserve");
      expect(res.body.message).toMatch(/available=\d+/);
    });

    it("rejects an unauthenticated creation before touching the chain", async () => {
      const res = await request(app.getHttpServer()).post("/policies").send({
        coverageEth: "0.1",
        premiumEth: "0.005",
        rainfallThresholdMm: 25,
        durationDays: 7,
      });

      expect(res.status).toBe(401);
    });
  });
});
