import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";

import { AppConfigService } from "../../config/app-config.service";
import { ChainProviderService } from "../blockchain/chain-provider.service";
import { ContractFactoryService } from "../blockchain/contract-factory.service";
import { PoliciesService } from "./policies.service";
import { PolicyChainService } from "./policy-chain.service";

const POLICY_ADDRESS = "0xcafac3dd18ac6c6e92c921884f9e4176737c052c";
const SIGNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const ORACLE = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const REGION_CODE =
  "0x56616c656e636961000000000000000000000000000000000000000000000000";
/** Block the harness pretends is current, so pinning is observable. */
const PINNED_BLOCK = 4242;

/** Values one policy contract returns, in the order the service reads them. */
function policyStub(): Record<string, () => Promise<unknown>> {
  return {
    insured: async () => SIGNER,
    oracle: async () => ORACLE,
    getStatus: async () => 1n,
    coverageWei: async () => 1_000_000_000_000_000_000n,
    premiumWei: async () => 50_000_000_000_000_000n,
    rainfallThresholdMm: async () => 50n,
    latestRainfallMm: async () => 0n,
    pendingPayoutWei: async () => 0n,
    conditionMet: async () => false,
    regionCode: async () => REGION_CODE,
    startTimestamp: async () => 1_785_009_789n,
    endTimestamp: async () => 1_787_601_789n,
    lastOracleUpdateTimestamp: async () => 0n,
  };
}

interface Harness {
  service: PolicyChainService;
  policies: PoliciesService;
  readPolicyCalls: string[];
  concurrentPeak: { value: number };
  /** Positional arguments passed to each contract write, in call order. */
  sentArgs: unknown[][];
  /** Overrides passed to each policy read, to verify block pinning. */
  blockTags: unknown[];
}

/**
 * Receipt shape the service reads after a successful write.
 *
 * Carries one log because the service takes the created address from the
 * `PolicyCreated` event rather than predicting it, and refuses a receipt that
 * lacks the event.
 */
function receiptStub(): Record<string, unknown> {
  return {
    hash: `0x${"ab".repeat(32)}`,
    blockNumber: 5,
    gasUsed: 1_541_309n,
    status: 1,
    logs: [{ topics: [`0x${"cd".repeat(32)}`], data: "0x" }],
  };
}

/** Interface stub exposing only what the service asks of it. */
function interfaceStub(): unknown {
  return {
    parseLog: () => ({
      name: "PolicyCreated",
      args: { policyAddress: POLICY_ADDRESS },
    }),
    // No revert data is decodable in these tests; failures fall through to the
    // transient/unknown branches, which is what the error specs cover.
    parseError: () => null,
  };
}

function buildHarness(
  options: {
    enabled?: boolean;
    hasSigner?: boolean;
    maxPageSize?: number;
    knownPolicy?: boolean;
    pageAddresses?: string[];
    total?: bigint;
    pageError?: unknown;
    chainTimestamp?: number;
    blockError?: boolean;
  } = {},
): Harness {
  const {
    enabled = true,
    hasSigner = true,
    maxPageSize = 50,
    knownPolicy = true,
    pageAddresses = [POLICY_ADDRESS],
    total = 1n,
    pageError,
    chainTimestamp = Math.floor(Date.now() / 1000),
    blockError = false,
  } = options;

  const readPolicyCalls: string[] = [];
  const sentArgs: unknown[][] = [];
  const concurrentPeak = { value: 0 };
  let inFlight = 0;

  /** Stands in for a contract write method plus its staticCall dry run. */
  const writeMethod = Object.assign(
    async (...args: unknown[]) => {
      sentArgs.push(args);
      return {
        hash: `0x${"ab".repeat(32)}`,
        wait: async () => receiptStub(),
      };
    },
    { staticCall: async () => POLICY_ADDRESS },
  );

  const blockTags: unknown[] = [];

  const providerReader = {
    isPolicyCreated: async () => knownPolicy,
    getAllPoliciesPage: async (_o: number, limit: number) => {
      if (pageError) {
        throw pageError;
      }
      return [pageAddresses.slice(0, limit), total];
    },
    getPoliciesByInsuredPage: async (_i: string, _o: number, limit: number) => [
      pageAddresses.slice(0, limit),
      total,
    ],
    getPolicySettlementInfo: async () => [0n, 0n],
    createPolicy: writeMethod,
    createPolicyWithMetadata: writeMethod,
  };

  const contracts = {
    getProviderReader: () => providerReader,
    getProviderWriter: () => providerReader,
    getPolicyReader: (address: string) => {
      readPolicyCalls.push(address);
      const stub = policyStub();
      // Track overlap so the concurrency bound is observable.
      return new Proxy(stub, {
        get: (target, prop: string) => async (overrides?: unknown) => {
          // Recorded so a test can assert every field came from one block.
          blockTags.push(overrides);
          inFlight += 1;
          concurrentPeak.value = Math.max(concurrentPeak.value, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return target[prop]();
        },
      });
    },
    getInterface: () => interfaceStub(),
  } as unknown as ContractFactoryService;

  const chain = {
    isEnabled: () => enabled,
    hasSigner: () => hasSigner,
    getSignerAddress: () => SIGNER,
    getBlockNumberFromNode: async () => PINNED_BLOCK,
    getProvider: () => ({
      getBlock: async () => {
        if (blockError) {
          throw Object.assign(new Error("node unreachable"), {
            code: "NETWORK_ERROR",
          });
        }
        return { timestamp: chainTimestamp };
      },
    }),
    call: <T>(_label: string, operation: () => Promise<T>) => operation(),
    submitTransaction: <T>(send: () => Promise<T>) => send(),
  } as unknown as ChainProviderService;

  const config = {
    blockchain: { maxPageSize, network: "localhost", confirmations: 1 },
  } as AppConfigService;

  const service = new PolicyChainService(chain, contracts, config);

  return {
    service,
    policies: new PoliciesService(service),
    readPolicyCalls,
    concurrentPeak,
    sentArgs,
    blockTags,
  };
}

describe("PolicyChainService", () => {
  describe("when the chain is not configured", () => {
    it.each([
      ["getPolicy", (s: PolicyChainService) => s.getPolicy(POLICY_ADDRESS)],
      ["listPolicies", (s: PolicyChainService) => s.listPolicies(0, 10)],
    ])("fails %s with an actionable 503", async (_name, invoke) => {
      const { service } = buildHarness({ enabled: false });

      await expect(invoke(service)).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(invoke(service)).rejects.toThrow(/RPC_URL/);
    });

    it("fails creation with a 503 naming the missing signer", async () => {
      const { service } = buildHarness({ hasSigner: false });

      await expect(
        service.createPolicy({
          coverageEth: "1.0",
          premiumEth: "0.05",
          rainfallThresholdMm: 50,
          durationDays: 30,
        }),
      ).rejects.toThrow(/PRIVATE_KEY/);
    });
  });

  describe("getPolicy", () => {
    it("normalizes on-chain primitives into API shapes", async () => {
      const { service } = buildHarness();

      const policy = await service.getPolicy(POLICY_ADDRESS);

      expect(policy).toMatchObject({
        address: POLICY_ADDRESS,
        status: "active",
        // uint256 stays a string; a number would corrupt large values.
        coverageWei: "1000000000000000000",
        rainfallThresholdMm: "50",
        region: "Valencia",
        settlementType: "none",
      });
      // Zero means unsettled, not "settled at the epoch".
      expect(policy?.settledAt).toBeUndefined();
    });

    it("returns undefined for an address the provider never created", async () => {
      // Without the isPolicyCreated guard this would read zeroed fields off an
      // arbitrary address and present them as a real policy.
      const { service } = buildHarness({ knownPolicy: false });

      await expect(service.getPolicy(POLICY_ADDRESS)).resolves.toBeUndefined();
    });

    it("answers every field from one pinned block", async () => {
      // The inconsistency this prevents: a policy is assembled from a dozen
      // calls, so a settlement mined midway through would produce a response
      // that never existed on chain — `status: active` beside
      // `settlementType: expiry`.
      const { service, blockTags } = buildHarness();

      await service.getPolicy(POLICY_ADDRESS);

      expect(blockTags.length).toBeGreaterThan(1);
      for (const overrides of blockTags) {
        expect(overrides).toEqual({ blockTag: PINNED_BLOCK });
      }
    });

    it("normalizes the requested address before querying", async () => {
      const { service, readPolicyCalls } = buildHarness();

      await service.getPolicy(POLICY_ADDRESS.toUpperCase().replace("0X", "0x"));

      expect(readPolicyCalls[0]).toBe(POLICY_ADDRESS);
    });
  });

  describe("listPolicies", () => {
    it("caps the page at the configured maximum", async () => {
      const addresses = Array.from({ length: 20 }, () => POLICY_ADDRESS);
      const { service } = buildHarness({
        maxPageSize: 5,
        pageAddresses: addresses,
        total: 20n,
      });

      const page = await service.listPolicies(0, 100);

      expect(page.items).toHaveLength(5);
      expect(page.appliedLimit).toBe(5);
      expect(page.total).toBe(20);
    });

    it("reports the applied limit so pagination cannot skip records", async () => {
      // The defect this prevents: a client asking for 100, receiving 50, and
      // advancing its offset by 100 silently drops fifty policies.
      const { policies } = buildHarness({
        maxPageSize: 5,
        pageAddresses: Array.from({ length: 20 }, () => POLICY_ADDRESS),
        total: 20n,
      });

      const response = await policies.list({
        offset: 0,
        limit: 100,
      } as never);

      expect(response.meta.limit).toBe(5);
      expect(response.meta.count).toBe(5);
      expect(response.meta.total).toBe(20);
    });

    it("bounds concurrent policy reads", async () => {
      // Each policy costs a dozen RPC calls; an unbounded fan-out over a full
      // page can push the node into rate limiting.
      const { service, concurrentPeak } = buildHarness({
        maxPageSize: 50,
        pageAddresses: Array.from({ length: 30 }, () => POLICY_ADDRESS),
        total: 30n,
      });

      await service.listPolicies(0, 30);

      // 5 policies in flight, each issuing its own reads concurrently.
      expect(concurrentPeak.value).toBeLessThanOrEqual(5 * 14);
      expect(concurrentPeak.value).toBeGreaterThan(0);
    });

    it("preserves the contract's ordering", async () => {
      const ordered = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
      ];
      const { service, readPolicyCalls } = buildHarness({
        pageAddresses: ordered,
        total: 3n,
      });

      const page = await service.listPolicies(0, 10);

      expect(readPolicyCalls).toEqual(ordered);
      expect(page.items.map((p) => p.address)).toEqual(ordered);
    });

    it("returns an empty page without issuing policy reads", async () => {
      const { service, readPolicyCalls } = buildHarness({
        pageAddresses: [],
        total: 0n,
      });

      const page = await service.listPolicies(0, 10);

      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
      expect(readPolicyCalls).toEqual([]);
    });

    it("maps a transient read failure to 503", async () => {
      const { service } = buildHarness({
        pageError: Object.assign(new Error("socket hang up"), {
          code: "ECONNRESET",
        }),
      });

      await expect(service.listPolicies(0, 10)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe("default start timestamp", () => {
    it("derives the default start from chain time, not server time", async () => {
      // The contract validates the start against block.timestamp. Deriving it
      // from server time fails on any chain whose clock runs behind the server:
      // the computed start lands in the chain's past and reverts.
      const chainNow = Math.floor(Date.now() / 1000) + 100_000;
      const { service, sentArgs } = buildHarness({ chainTimestamp: chainNow });

      await service.createPolicy({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        region: "Valencia",
      });

      // params: [coverage, threshold, duration, regionCode, requestedStart]
      const requestedStart = Number(sentArgs.at(-1)?.[4]);
      expect(requestedStart).toBeGreaterThan(chainNow);
      expect(requestedStart).toBeLessThanOrEqual(chainNow + 600);
    });

    it("honors an explicit start instead of deriving one", async () => {
      const explicitStart = Math.floor(Date.now() / 1000) + 7_200;
      const { service, sentArgs } = buildHarness();

      await service.createPolicy({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        region: "Valencia",
        requestedStartTimestamp: explicitStart,
      });

      expect(Number(sentArgs.at(-1)?.[4])).toBe(explicitStart);
    });

    it("falls back to server time when the block cannot be read", async () => {
      // A transient RPC hiccup must not fail a request the contract would
      // accept; the fallback is an approximation, not a correctness guarantee.
      const { service, sentArgs } = buildHarness({ blockError: true });

      await service.createPolicy({
        coverageEth: "1.0",
        premiumEth: "0.05",
        rainfallThresholdMm: 50,
        durationDays: 30,
        region: "Valencia",
      });

      const requestedStart = Number(sentArgs.at(-1)?.[4]);
      expect(requestedStart).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  describe("createPolicy validation surface", () => {
    it("rejects a region that cannot fit in bytes32", async () => {
      const { service } = buildHarness();

      await expect(
        service.createPolicy({
          coverageEth: "1.0",
          premiumEth: "0.05",
          rainfallThresholdMm: 50,
          durationDays: 30,
          region: "x".repeat(40),
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

describe("PoliciesService", () => {
  it("turns an unknown policy into 404 rather than an empty body", async () => {
    // A 404 tells the caller the address is wrong; a 5xx would suggest
    // retrying something that can never succeed.
    const { policies } = buildHarness({ knownPolicy: false });

    await expect(policies.getByAddress(POLICY_ADDRESS)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("returns the mapped policy for a known address", async () => {
    const { policies } = buildHarness();

    const response = await policies.getByAddress(POLICY_ADDRESS);

    expect(response.address).toBe(POLICY_ADDRESS);
    expect(response.region).toBe("Valencia");
  });
});
