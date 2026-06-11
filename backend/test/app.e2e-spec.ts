import "reflect-metadata";

import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module";

const VALID_ADDRESS = "0x1111111111111111111111111111111111111111";

describe("ClimateChain backend (e2e)", () => {
  let app: INestApplication;
  let jwtService: JwtService;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.LOG_LEVEL = "silent";
    process.env.ADMIN_API_KEY = "test-admin-key";
    process.env.JWT_SECRET = "e2e-test-jwt-secret-0123456789";

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    jwtService = app.get(JwtService, { strict: false });
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

    it("GET /health/ready -> 200 with config and registry up", async () => {
      const res = await request(app.getHttpServer()).get("/health/ready");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.details["contract-registry"].status).toBe("up");
      expect(res.body.details.config.status).toBe("up");
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
    });
  });

  describe("policies", () => {
    it("rejects an invalid create body with 400 and the error contract", async () => {
      const res = await request(app.getHttpServer()).post("/policies").send({
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
      const res = await request(app.getHttpServer()).post("/policies").send({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        unexpectedField: true,
      });
      expect(res.status).toBe(400);
    });

    it("returns 501 for a valid create (live integration arrives in Stage 06)", async () => {
      const res = await request(app.getHttpServer()).post("/policies").send({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        region: "Valencia",
      });
      expect(res.status).toBe(501);
      expect(res.body.message).toContain("Stage 06");
    });

    it("rejects an invalid policy address with 400", async () => {
      const res = await request(app.getHttpServer()).get(
        "/policies/not-an-address",
      );
      expect(res.status).toBe(400);
    });

    it("returns 501 for a valid policy address lookup", async () => {
      const res = await request(app.getHttpServer()).get(
        `/policies/${VALID_ADDRESS}`,
      );
      expect(res.status).toBe(501);
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
        .send({ apiKey: "test-admin-key" });
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
  });
});
