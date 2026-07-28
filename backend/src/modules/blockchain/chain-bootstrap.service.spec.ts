import { Logger } from "@nestjs/common";
import { keccak256 } from "ethers";

import { LEGACY_REGION_CODE } from "../../common/utils/region-code.util";
import { AppConfigService } from "../../config/app-config.service";
import { POLICY_DOMAIN } from "../policies/policy.constants";
import { ChainBootstrapService } from "./chain-bootstrap.service";
import { ChainProviderService } from "./chain-provider.service";
import { ContractFactoryService } from "./contract-factory.service";
import { ContractRegistryService } from "./contract-registry.service";

const PROVIDER_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const ORACLE_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const DEPLOYED_CODE = `0x${"60".repeat(64)}`;

interface Harness {
  service: ChainBootstrapService;
  getCode: jest.Mock;
  constants: Record<string, jest.Mock>;
  send: jest.Mock;
}

/**
 * Builds the service with every collaborator stubbed at the RPC boundary.
 *
 * These are the abort paths that stop the service from serving traffic against
 * the wrong chain, so each needs to be reachable in a test — an untested
 * safety net is an assumption, not a guarantee.
 */
function buildHarness(
  overrides: {
    enabled?: boolean;
    nodeChainId?: bigint;
    manifestChainId?: string;
    codeByAddress?: Record<string, string>;
    constantValues?: Partial<Record<string, bigint>>;
    oracleAddress?: string;
    signerAddress?: string;
    signerBalance?: bigint;
    coverageReserve?: bigint;
    legacyRegionCode?: string;
    runtimeBytecodeHashes?: Record<string, string> | null;
  } = {},
): Harness {
  const {
    enabled = true,
    nodeChainId = 31337n,
    manifestChainId = "31337",
    codeByAddress = {
      [PROVIDER_ADDRESS]: DEPLOYED_CODE,
      [ORACLE_ADDRESS]: DEPLOYED_CODE,
    },
    constantValues = {},
    signerBalance = 10n ** 18n,
    coverageReserve = 10n ** 19n,
    legacyRegionCode = LEGACY_REGION_CODE,
  } = overrides;

  // `null` models a manifest written before hashes were recorded; the
  // default records the hash of the code the harness actually serves.
  const runtimeBytecodeHashes =
    "runtimeBytecodeHashes" in overrides
      ? overrides.runtimeBytecodeHashes
      : {
          insuranceProvider: keccak256(DEPLOYED_CODE),
          weatherOracle: keccak256(DEPLOYED_CODE),
        };

  // Read through `in` rather than a destructuring default: an explicitly
  // passed `undefined` is the case under test ("no oracle in the manifest"),
  // and a default would silently replace it.
  const oracleAddress =
    "oracleAddress" in overrides ? overrides.oracleAddress : ORACLE_ADDRESS;
  const signerAddress =
    "signerAddress" in overrides
      ? overrides.signerAddress
      : "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

  const getCode = jest.fn(
    async (address: string) => codeByAddress[address] ?? "0x",
  );

  /**
   * Answers `eth_chainId` the way a node does, in hex.
   *
   * Stubbed at the raw-RPC level on purpose. An earlier version of this harness
   * stubbed `provider.getNetwork()`, which made the chain-id test pass while the
   * production path could not fail: with `staticNetwork` active, `getNetwork()`
   * returns the configured value without contacting the node, so the check was
   * comparing configuration with itself. The test validated the mock, not the
   * system.
   */
  const send = jest.fn(async (method: string) => {
    if (method === "eth_chainId") {
      return `0x${nodeChainId.toString(16)}`;
    }
    throw new Error(`unexpected RPC method ${method}`);
  });

  const provider = {
    send,
    getBlockNumber: jest.fn(async () => 42),
    getBalance: jest.fn(async () => signerBalance),
    getCode,
  };

  const constants: Record<string, jest.Mock> = {
    MAX_DURATION_DAYS: jest.fn(
      async () =>
        constantValues.MAX_DURATION_DAYS ??
        BigInt(POLICY_DOMAIN.maxDurationDays),
    ),
    MIN_PREMIUM_BPS: jest.fn(
      async () =>
        constantValues.MIN_PREMIUM_BPS ?? BigInt(POLICY_DOMAIN.minPremiumBps),
    ),
    BASIS_POINTS_DENOMINATOR: jest.fn(
      async () =>
        constantValues.BASIS_POINTS_DENOMINATOR ??
        BigInt(POLICY_DOMAIN.basisPointsDenominator),
    ),
    MIN_POLICY_START_LEAD_TIME_SECONDS: jest.fn(
      async () =>
        constantValues.MIN_POLICY_START_LEAD_TIME_SECONDS ??
        BigInt(POLICY_DOMAIN.minPolicyStartLeadTimeSeconds),
    ),
    MAX_POLICY_START_LEAD_TIME_SECONDS: jest.fn(
      async () =>
        constantValues.MAX_POLICY_START_LEAD_TIME_SECONDS ??
        BigInt(POLICY_DOMAIN.maxPolicyStartLeadTimeSeconds),
    ),
  };

  const reader = {
    ...constants,
    coverageReserveWei: jest.fn(async () => coverageReserve),
    premiumBalanceWei: jest.fn(async () => 0n),
    LEGACY_REGION_CODE: jest.fn(async () => legacyRegionCode),
  };

  const chain = {
    isEnabled: () => enabled,
    hasSigner: () => signerAddress !== undefined,
    getProvider: () => provider,
    getSignerAddress: () => signerAddress,
    call: <T>(_label: string, operation: () => Promise<T>) => operation(),
    // Mirror the real implementations: raw requests, parsed from hex.
    getChainIdFromNode: async () =>
      BigInt((await send("eth_chainId")) as string).toString(),
    getBlockNumberFromNode: async () => 42,
  } as unknown as ChainProviderService;

  const contracts = {
    getProviderReader: () => reader,
  } as unknown as ContractFactoryService;

  const registry = {
    getChainId: () => manifestChainId,
    getProviderAddress: () => PROVIDER_ADDRESS,
    getOracleAddress: () => oracleAddress,
    getManifest: () => ({
      contracts: {
        insuranceProvider: PROVIDER_ADDRESS,
        weatherOracle: ORACLE_ADDRESS,
      },
      ...(runtimeBytecodeHashes ? { runtimeBytecodeHashes } : {}),
    }),
  } as unknown as ContractRegistryService;

  const config = {
    blockchain: { network: "localhost" },
  } as AppConfigService;

  return {
    service: new ChainBootstrapService(config, chain, contracts, registry),
    getCode,
    constants,
    send,
  };
}

describe("ChainBootstrapService", () => {
  beforeAll(() => {
    // The service logs its verdict and its warnings; silence them so failures
    // stand out in the test output.
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe("when chain access is disabled", () => {
    it("skips verification instead of failing", async () => {
      // A local profile without a node is a supported state; readiness reports
      // it. Aborting boot here would make the service unrunnable offline.
      const { service, getCode } = buildHarness({ enabled: false });

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(service.getVerification()).toBeUndefined();
      expect(getCode).not.toHaveBeenCalled();
    });
  });

  describe("successful verification", () => {
    it("records a snapshot of what it verified", async () => {
      const { service } = buildHarness();

      await service.onApplicationBootstrap();
      const verification = service.getVerification();

      expect(verification).toMatchObject({
        chainId: "31337",
        blockNumber: 42,
        providerAddress: PROVIDER_ADDRESS,
        oracleAddress: ORACLE_ADDRESS,
        coverageReserveWei: "10000000000000000000",
      });
      expect(verification?.providerCodeSize).toBeGreaterThan(0);
      expect(verification?.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("verifies without an oracle when the manifest declares none", async () => {
      const { service } = buildHarness({ oracleAddress: undefined });

      await service.onApplicationBootstrap();

      expect(service.getVerification()?.oracleAddress).toBeUndefined();
      expect(service.getVerification()?.oracleCodeSize).toBeUndefined();
    });

    it("proceeds with warnings when the reserve is empty", async () => {
      // Not fatal: reads still work and the owner can fund at any time. It must
      // be visible, but refusing to boot would be wrong.
      const { service } = buildHarness({ coverageReserve: 0n });

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(service.getVerification()?.coverageReserveWei).toBe("0");
    });

    it("proceeds with warnings when the signer has no balance", async () => {
      const { service } = buildHarness({ signerBalance: 0n });

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(service.getVerification()?.signerBalanceWei).toBe("0");
    });
  });

  describe("bytecode identity", () => {
    it("aborts when the address holds a different contract than was deployed", async () => {
      // Presence of code proves nothing on its own: an older provider left on
      // the chain, or an address pasted from another network, all have code and
      // all pass a "something is deployed here" check, then misbehave on the
      // first call as an inscrutable decoding error.
      const { service } = buildHarness({
        runtimeBytecodeHashes: {
          insuranceProvider: `0x${"11".repeat(32)}`,
          weatherOracle: `0x${"11".repeat(32)}`,
        },
      });

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /does not match the deployment manifest/,
      );
      expect(service.getVerification()).toBeUndefined();
    });

    it("passes when the deployed code matches what the manifest recorded", async () => {
      const { service } = buildHarness();

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(service.getVerification()).toBeDefined();
    });

    it("says so out loud when the manifest records no hash", async () => {
      // A manifest written before hashes existed cannot be verified. Treating
      // that silently as a pass would leave the weak check in place while
      // looking like the strong one.
      const warn = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);
      const { service } = buildHarness({ runtimeBytecodeHashes: null });

      try {
        await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("No runtime bytecode hash recorded"),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("fatal misconfiguration", () => {
    it("aborts when the node runs a different chain than the manifest", async () => {
      // Pointing at the wrong chain is silent otherwise: addresses parse, calls
      // return zeroes, and every policy read looks empty rather than wrong.
      const { service } = buildHarness({
        nodeChainId: 11155111n,
        manifestChainId: "31337",
      });

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /chainId=11155111.*manifest declares chainId=31337/s,
      );
      expect(service.getVerification()).toBeUndefined();
    });

    it("asks the node for the chain id rather than trusting configuration", async () => {
      // The regression this locks down: reading the chain id through
      // `provider.getNetwork()` returns the configured value without a round
      // trip whenever `staticNetwork` is active, so the comparison above would
      // pass against any chain. Only a real request can detect the mismatch.
      const { service, send } = buildHarness();

      await service.onApplicationBootstrap();

      expect(send).toHaveBeenCalledWith("eth_chainId");
    });

    it("aborts when no contract is deployed at the provider address", async () => {
      const { service } = buildHarness({ codeByAddress: {} });

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /No contract code found at/,
      );
    });

    it("names the manifest to regenerate when bytecode is missing", async () => {
      const { service } = buildHarness({ codeByAddress: {} });

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /contracts\/deployments\/localhost\.json/,
      );
    });

    it("aborts when the oracle address holds no code", async () => {
      const { service } = buildHarness({
        codeByAddress: { [PROVIDER_ADDRESS]: DEPLOYED_CODE },
      });

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /weather oracle/,
      );
    });

    it.each([
      ["MAX_DURATION_DAYS", 180n],
      ["MIN_PREMIUM_BPS", 250n],
      ["BASIS_POINTS_DENOMINATOR", 1000n],
      ["MIN_POLICY_START_LEAD_TIME_SECONDS", 3600n],
    ])(
      "aborts when the deployed %s disagrees with POLICY_DOMAIN",
      async (name, deployedValue) => {
        // A mismatch means DTO validation and the contract disagree: the API
        // would accept requests that revert, or reject ones that would succeed.
        const { service } = buildHarness({
          constantValues: { [name]: deployedValue },
        });

        await expect(service.onApplicationBootstrap()).rejects.toThrow(
          new RegExp(`${name}: chain=${deployedValue}`),
        );
      },
    );

    it("aborts when the deployed LEGACY_REGION_CODE differs", async () => {
      // Requests without a region are filed under this placeholder. If the
      // mirror drifted, those policies would carry a code nothing else
      // recognizes — readable, but invisible to consumers filtering on the
      // real one.
      const { service } = buildHarness({
        legacyRegionCode: `0x${"11".repeat(32)}`,
      });

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /LEGACY_REGION_CODE/,
      );
    });

    it("reports every mismatched constant at once", async () => {
      const { service } = buildHarness({
        constantValues: { MAX_DURATION_DAYS: 180n, MIN_PREMIUM_BPS: 250n },
      });

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /MAX_DURATION_DAYS.*MIN_PREMIUM_BPS/s,
      );
    });

    it("names the network in every failure", async () => {
      const { service } = buildHarness({ nodeChainId: 1n });

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /network "localhost"/,
      );
    });
  });
});
