import { HealthIndicatorService } from "@nestjs/terminus";

import { AppConfigService } from "../../../config/app-config.service";
import {
  ChainBootstrapService,
  ChainVerification,
} from "../../blockchain/chain-bootstrap.service";
import { ChainProviderService } from "../../blockchain/chain-provider.service";
import { ChainHealthIndicator } from "./chain.health";

const VERIFICATION: ChainVerification = {
  verifiedAt: "2026-07-25T19:57:52.572Z",
  chainId: "31337",
  blockNumber: 4,
  providerAddress: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  providerCodeSize: 15037,
  oracleAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  oracleCodeSize: 2876,
  signerAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  signerBalanceWei: "1000000000000000000",
  coverageReserveWei: "10000000000000000000",
  premiumBalanceWei: "0",
};

/** Minimal stand-in for Terminus' indicator builder. */
function buildIndicatorService(): HealthIndicatorService {
  return {
    check: (key: string) => ({
      up: (detail: Record<string, unknown> = {}) => ({
        [key]: { status: "up", ...detail },
      }),
      down: (detail: Record<string, unknown> = {}) => ({
        [key]: { status: "down", ...detail },
      }),
    }),
  } as unknown as HealthIndicatorService;
}

function buildIndicator(options: {
  enabled?: boolean;
  verification?: ChainVerification;
  blockNumber?: number | Error;
  deployedProfile?: boolean;
  /** Chain id the node currently reports, to simulate a repointed endpoint. */
  nodeChainId?: string;
}): ChainHealthIndicator {
  const {
    enabled = true,
    blockNumber = 99,
    deployedProfile = false,
    nodeChainId = "31337",
  } = options;

  // Read through `in`: an explicitly passed `undefined` is the case under test
  // ("verification never completed"), which a destructuring default would hide.
  const verification =
    "verification" in options ? options.verification : VERIFICATION;

  const chain = {
    isEnabled: () => enabled,
    hasSigner: () => true,
    getProvider: () => ({}),
    getChainIdFromNode: async () => nodeChainId,
    call: async () => {
      if (blockNumber instanceof Error) {
        throw blockNumber;
      }
      return blockNumber;
    },
  } as unknown as ChainProviderService;

  const bootstrap = {
    getVerification: () => verification,
  } as unknown as ChainBootstrapService;

  const config = { isDeployedProfile: deployedProfile } as AppConfigService;

  return new ChainHealthIndicator(
    buildIndicatorService(),
    chain,
    bootstrap,
    config,
  );
}

describe("ChainHealthIndicator", () => {
  it("reports down when no RPC endpoint is configured", async () => {
    // Not "broken", but genuinely not ready to serve policy traffic. Reporting
    // up here would claim a capability the service cannot deliver.
    const result = await buildIndicator({ enabled: false }).isHealthy("chain");

    expect(result.chain.status).toBe("down");
    expect(String(result.chain.reason)).toContain("RPC_URL");
  });

  it("reports down when boot verification never completed", async () => {
    const result = await buildIndicator({
      verification: undefined,
    }).isHealthy("chain");

    expect(result.chain.status).toBe("down");
    expect(String(result.chain.reason)).toContain("startup");
  });

  it("reports down when the endpoint stops responding", async () => {
    // The reason this issues a live call instead of replaying the boot verdict:
    // a node can go down long after a successful startup.
    const result = await buildIndicator({
      blockNumber: Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
      }),
    }).isHealthy("chain");

    expect(result.chain.status).toBe("down");
    expect(String(result.chain.reason)).toContain("socket hang up");
  });

  it("reports down when the endpoint now serves a different chain", async () => {
    // The drift this catches: RPC_URL repointed at another chain after a
    // successful boot. Reporting the chain id recorded at startup would keep
    // claiming the right chain while every read came from the wrong one.
    const result = await buildIndicator({ nodeChainId: "11155111" }).isHealthy(
      "chain",
    );

    expect(result.chain.status).toBe("down");
    expect(String(result.chain.reason)).toContain("11155111");
    expect(String(result.chain.reason)).toContain("31337");
  });

  it("reports up with live diagnostics on local profiles", async () => {
    const result = await buildIndicator({ blockNumber: 120 }).isHealthy(
      "chain",
    );

    expect(result.chain).toMatchObject({
      status: "up",
      chainId: "31337",
      blockNumber: 120,
      providerAddress: VERIFICATION.providerAddress,
      coverageReserveWei: "10000000000000000000",
    });
  });

  it("exposes only the verdict on deployed profiles", async () => {
    // Block heights, balances, and the signer address are useful locally and
    // are reconnaissance material on a public endpoint.
    const result = await buildIndicator({ deployedProfile: true }).isHealthy(
      "chain",
    );

    expect(result.chain).toEqual({ status: "up", chainId: "31337" });
    expect(result.chain.signerAddress).toBeUndefined();
    expect(result.chain.coverageReserveWei).toBeUndefined();
  });
});
