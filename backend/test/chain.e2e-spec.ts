import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { Contract, JsonRpcProvider, NonceManager, Wallet } from "ethers";
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

/**
 * Set at module scope, not inside a describe.
 *
 * Every test here waits on real block production, and the lifecycle tests take
 * seconds even on a fast machine — comfortably over Jest's 5s default. Declaring
 * the timeout at the top removes any dependence on when the surrounding
 * describe body happens to execute.
 */
jest.setTimeout(180_000);

/** Loads an exported ABI so the harness drives the same artifacts the API uses. */
function loadAbi(contractName: string): unknown[] {
  const path = resolve(
    process.cwd(),
    "..",
    "shared",
    "abi",
    `${contractName}.json`,
  );
  return (JSON.parse(readFileSync(path, "utf-8")) as { abi: unknown[] }).abi;
}

/** Reads the deployed addresses the backend also resolves from. */
function loadManifest(): { insuranceProvider: string; weatherOracle: string } {
  const path = resolve(
    process.cwd(),
    "..",
    "contracts",
    "deployments",
    `${NETWORK}.json`,
  );
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as {
    contracts: { insuranceProvider: string; weatherOracle: string };
  };
  return manifest.contracts;
}

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
    // `init` runs the application-bootstrap hooks, so chain verification has
    // already succeeded by the time the first request is issued.
    await app.init();

    const jwt = app.get(JwtService, { strict: false });
    bearer = `Bearer ${jwt.sign({ sub: "admin", roles: ["admin"] })}`;

    // Derived here rather than captured inside a test: several tests compare
    // against it, and a value assigned by one test is a dependency on execution
    // order that turns one failure into a cascade of confusing ones.
    signerAddress = new Wallet(SIGNER_KEY).address.toLowerCase();
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
      expect(String(res.body.details.chain.signerAddress).toLowerCase()).toBe(
        signerAddress,
      );
    });
  });

  describe("policy creation", () => {
    it("creates a policy and returns its transaction metadata", async () => {
      const res = await request(app.getHttpServer())
        .post("/policies")
        .set("Authorization", bearer)
        .set("Idempotency-Key", "create-metadata")
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

    it("creates concurrent policies without a nonce collision", async () => {
      // The regression this guards: every transaction from one account needs
      // the next sequential nonce, and asking the node for it per transaction
      // returns a stale value under concurrency. Before local nonce tracking
      // plus submission queuing, this failed with NONCE_EXPIRED.
      const create = (threshold: number) =>
        request(app.getHttpServer())
          .post("/policies")
          .set("Authorization", bearer)
          // Distinct keys: these are three different logical requests.
          .set("Idempotency-Key", `concurrent-${threshold}`)
          .send({
            coverageEth: "0.05",
            premiumEth: "0.002",
            rainfallThresholdMm: threshold,
            durationDays: 7,
            region: "Concurrent",
          });

      const responses = await Promise.all([create(11), create(12), create(13)]);

      expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
      // Distinct policies, not one transaction reported three times.
      const addresses = responses.map((r) => r.body.address);
      expect(new Set(addresses).size).toBe(3);
      expect(new Set(responses.map((r) => r.body.transactionHash)).size).toBe(
        3,
      );
    });

    it("creates only one policy for a repeated Idempotency-Key", async () => {
      // The failure this prevents costs money: a client retrying after a
      // timeout would otherwise create a second policy and draw the coverage
      // reserve down twice.
      const body = {
        coverageEth: "0.03",
        premiumEth: "0.001",
        rainfallThresholdMm: 33,
        durationDays: 7,
        region: "Idempotent",
      };
      const send = () =>
        request(app.getHttpServer())
          .post("/policies")
          .set("Authorization", bearer)
          .set("Idempotency-Key", "chain-e2e-key-1")
          .send(body);

      const first = await send();
      expect(first.status).toBe(201);

      const replay = await send();
      expect(replay.status).toBe(201);
      // Same policy, same transaction: nothing new was submitted.
      expect(replay.body.address).toBe(first.body.address);
      expect(replay.body.transactionHash).toBe(first.body.transactionHash);
    });

    it("rejects a reused Idempotency-Key with a different body", async () => {
      const res = await request(app.getHttpServer())
        .post("/policies")
        .set("Authorization", bearer)
        .set("Idempotency-Key", "chain-e2e-key-1")
        .send({
          coverageEth: "0.09",
          premiumEth: "0.003",
          rainfallThresholdMm: 44,
          durationDays: 7,
          region: "Different",
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain("different request body");
    });

    it("creates a policy through the legacy path when no region is given", async () => {
      const res = await request(app.getHttpServer())
        .post("/policies")
        .set("Authorization", bearer)
        .set("Idempotency-Key", "create-legacy")
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

    it("reports the applied page limit, not the requested one", async () => {
      // Guards the pagination contract: a client that advanced its offset by
      // the value it asked for would skip every record the cap removed.
      const res = await request(app.getHttpServer())
        .get("/policies")
        .query({ offset: 0, limit: 100 });

      expect(res.status).toBe(200);
      expect(res.body.meta.limit).toBeLessThanOrEqual(50);
      expect(res.body.data.length).toBe(res.body.meta.count);
      expect(res.body.meta.count).toBeLessThanOrEqual(res.body.meta.limit);
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
        .set("Idempotency-Key", "over-reserve")
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

  /**
   * Reads across the full policy lifecycle.
   *
   * Every test above observes a freshly created policy, so they only ever
   * exercise `active` / `settlementType: none` / `pendingPayoutWei: 0`. The
   * status and settlement mappings exist precisely for the other states, and
   * until now nothing verified them against real on-chain state — a mapping
   * error would have surfaced the first time a policy actually paid out.
   *
   * The lifecycle transitions themselves are owner-only contract operations
   * that the backend does not drive until Stage 10, so this harness performs
   * them directly against the contracts and then asserts what the **API**
   * reports. It tests the read path, not a backend capability that exists.
   *
   * Declared last on purpose: it moves the chain clock forward, and a later
   * creation would compute its start from wall-clock time, landing in the
   * chain's past and reverting.
   */
  describe("policy lifecycle as reported by the API", () => {
    let chainProvider: JsonRpcProvider;
    let insuranceProvider: Contract;
    let weatherOracle: Contract;
    let triggeredAddress: string;
    let expiringAddress: string;

    const THRESHOLD_MM = 40;
    const START_LEAD_SECONDS = 200;
    const DURATION_DAYS = 1;

    /** Moves the chain clock forward and mines, so time-gated guards open. */
    const advanceChain = async (seconds: number): Promise<void> => {
      await chainProvider.send("evm_increaseTime", [seconds]);
      await chainProvider.send("evm_mine", []);
    };

    /**
     * A start both clocks accept.
     *
     * The DTO validates a caller-supplied start against wall-clock time, while
     * the contract validates it against `block.timestamp`. Those diverge here
     * because this suite moves the chain clock, so taking the later of the two
     * is what satisfies both. On a real network they agree within seconds.
     */
    const acceptableStart = async (): Promise<number> => {
      const block = await chainProvider.getBlock("latest");
      const chainNow = Number(block?.timestamp ?? 0);
      const serverNow = Math.floor(Date.now() / 1000);
      return Math.max(chainNow, serverNow) + START_LEAD_SECONDS;
    };

    const createPolicy = async (region: string): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post("/policies")
        .set("Authorization", bearer)
        .set("Idempotency-Key", `lifecycle-${region}`)
        .send({
          coverageEth: "0.05",
          premiumEth: "0.002",
          rainfallThresholdMm: THRESHOLD_MM,
          durationDays: DURATION_DAYS,
          region,
          requestedStartTimestamp: await acceptableStart(),
        });

      expect(res.status).toBe(201);
      return res.body.address as string;
    };

    const readPolicy = async (address: string) => {
      const res = await request(app.getHttpServer()).get(
        `/policies/${address}`,
      );
      expect(res.status).toBe(200);
      return res.body;
    };

    beforeAll(async () => {
      // `cacheTimeout: -1` disables the provider's response cache. Combined
      // with the NonceManager below, nothing about transaction ordering here
      // depends on how recently a value was read from the node.
      chainProvider = new JsonRpcProvider(RPC_URL, undefined, {
        cacheTimeout: -1,
      });

      /*
       * The owner is wrapped in a NonceManager, which assigns nonces from a
       * local counter instead of asking the node before each send.
       *
       * This harness signs with the same account as the backend, so there were
       * two independent nonce sources for one account: the backend's own
       * NonceManager and a plain Wallet here reading the node. A read that
       * lagged the backend's last transaction by one produced NONCE_EXPIRED.
       *
       * It passed locally and failed in CI because CI is *faster*: these
       * transitions ran 182ms and 62ms apart there versus ~4.3s here, so the
       * stale window only mattered on the quicker machine. A test whose result
       * depends on how fast the host is has to be made deterministic, not
       * retried.
       *
       * Safe because the backend performs no writes during this describe — it
       * only serves reads. Adding a backend write here would reintroduce the
       * contention.
       */
      const owner = new NonceManager(new Wallet(SIGNER_KEY, chainProvider));
      const addresses = loadManifest();

      insuranceProvider = new Contract(
        addresses.insuranceProvider,
        loadAbi("InsuranceProvider") as never,
        owner,
      );
      weatherOracle = new Contract(
        addresses.weatherOracle,
        loadAbi("MockWeatherOracle") as never,
        owner,
      );

      // Both policies are created before any clock movement, for the reason in
      // the describe comment.
      triggeredAddress = await createPolicy("Triggered");
      expiringAddress = await createPolicy("Expiring");

      // Past the requested start, so each policy's weather window is open.
      await advanceChain(START_LEAD_SECONDS + 60);
    });

    afterAll(() => {
      chainProvider?.destroy();
    });

    it("reports a policy as triggered after the oracle reports rainfall", async () => {
      const before = await readPolicy(triggeredAddress);
      expect(before.status).toBe("active");
      expect(before.conditionMet).toBe(false);
      expect(before.lastOracleUpdateTimestamp).toBe(0);

      // Rainfall at or above the threshold is what trips the policy.
      await (
        await weatherOracle["pushWeatherData(address,uint256)"](
          triggeredAddress,
          THRESHOLD_MM + 10,
        )
      ).wait();

      const after = await readPolicy(triggeredAddress);

      expect(after.status).toBe("triggered");
      expect(after.conditionMet).toBe(true);
      expect(after.latestRainfallMm).toBe(String(THRESHOLD_MM + 10));
      expect(after.lastOracleUpdateTimestamp).toBeGreaterThan(0);
      // Not settled yet: the provider has not executed the payout.
      expect(after.settlementType).toBe("none");
      expect(after.paidOut).toBe(false);
    });

    it("reports a policy as paid out after the payout executes", async () => {
      await (
        await insuranceProvider.executePolicyPayout(triggeredAddress)
      ).wait();

      const policy = await readPolicy(triggeredAddress);

      expect(policy.status).toBe("paid_out");
      expect(policy.paidOut).toBe(true);
      expect(policy.settlementType).toBe("payout");
      expect(policy.settledAt).toBeGreaterThan(0);
      // The insured is an externally owned account here, so the transfer
      // succeeded and nothing is left to claim. The deferred-claim path needs a
      // recipient that rejects ETH, which is covered by the contract tests.
      expect(policy.pendingPayoutWei).toBe("0");
    });

    it("reports a policy as expired after its window closes", async () => {
      await advanceChain(DURATION_DAYS * 86_400 + 60);

      await (await insuranceProvider.expirePolicy(expiringAddress)).wait();

      const policy = await readPolicy(expiringAddress);

      expect(policy.status).toBe("expired");
      expect(policy.settlementType).toBe("expiry");
      expect(policy.settledAt).toBeGreaterThan(0);
      expect(policy.paidOut).toBe(false);
      expect(policy.conditionMet).toBe(false);
    });

    it("keeps settled policies visible and readable after settlement", async () => {
      // Settlement must not remove a policy from the provider's index: the
      // record has to stay auditable after the money has moved.
      //
      // Asserted per address rather than by scanning a page. The index grows
      // with every run on a shared node, so a fixed page would eventually stop
      // containing this run's policies and the test would fail for a reason
      // that has nothing to do with the behavior under test.
      const settled = await readPolicy(triggeredAddress);
      expect(settled.status).toBe("paid_out");

      const expired = await readPolicy(expiringAddress);
      expect(expired.status).toBe("expired");

      // Both still appear in the provider's own index.
      const total = await insuranceProvider.getAllPoliciesCount();
      expect(Number(total)).toBeGreaterThanOrEqual(2);
    });
  });
});
