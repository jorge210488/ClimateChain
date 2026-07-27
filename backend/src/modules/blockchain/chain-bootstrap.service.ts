import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";

import { AppConfigService } from "../../config/app-config.service";
import { POLICY_DOMAIN } from "../policies/policy.constants";
import { ChainProviderService } from "./chain-provider.service";
import { ContractFactoryService } from "./contract-factory.service";
import { ContractRegistryService } from "./contract-registry.service";

/** Result of the boot-time chain verification, surfaced by readiness. */
export interface ChainVerification {
  verifiedAt: string;
  chainId: string;
  blockNumber: number;
  providerAddress: string;
  providerCodeSize: number;
  oracleAddress?: string;
  oracleCodeSize?: number;
  signerAddress?: string;
  signerBalanceWei?: string;
  coverageReserveWei: string;
  premiumBalanceWei: string;
}

/** On-chain constants mirrored by `POLICY_DOMAIN`, read back for comparison. */
const MIRRORED_CONSTANTS = [
  ["MAX_DURATION_DAYS", "maxDurationDays"],
  ["MIN_PREMIUM_BPS", "minPremiumBps"],
  ["BASIS_POINTS_DENOMINATOR", "basisPointsDenominator"],
  ["MIN_POLICY_START_LEAD_TIME_SECONDS", "minPolicyStartLeadTimeSeconds"],
] as const;

/**
 * Verifies at boot that the configured chain actually matches what the backend
 * believes about it.
 *
 * Stage 05 could only check that the deployment manifest parsed. That left a
 * gap the manifest cannot close: a well-formed file pointing at a chain where
 * nothing is deployed, or at contracts whose rules differ from the ones the
 * API validates against. Both fail here instead of on a user's first request.
 *
 * Verification runs on application bootstrap rather than module init, so a
 * failure is reported after the rest of the graph is constructed and the
 * diagnostic is not buried among initialization logs.
 */
@Injectable()
export class ChainBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ChainBootstrapService.name);
  private verification?: ChainVerification;

  constructor(
    private readonly config: AppConfigService,
    private readonly chain: ChainProviderService,
    private readonly contracts: ContractFactoryService,
    private readonly registry: ContractRegistryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.chain.isEnabled()) {
      // Reads and writes are unavailable, which readiness reports. Local
      // profiles are allowed to run without a node; deployed profiles cannot
      // reach here, since boot already requires RPC_URL for them.
      this.logger.warn(
        "No RPC endpoint configured; chain integration is disabled. " +
          "Set RPC_URL to enable policy reads and writes.",
      );
      return;
    }

    try {
      this.verification = await this.verify();
      this.logSuccess(this.verification);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Chain verification failed against RPC_URL for network ` +
          `"${this.config.blockchain.network}". ${message}`,
      );
    }
  }

  /** Verification snapshot, or undefined when chain access is disabled. */
  getVerification(): ChainVerification | undefined {
    return this.verification;
  }

  private async verify(): Promise<ChainVerification> {
    const provider = this.chain.getProvider();
    const expectedChainId = this.registry.getChainId();

    // Asked of the node directly. `provider.getNetwork()` would return the
    // configured value without a round trip whenever `staticNetwork` is active,
    // making this comparison config-against-config and true on any chain.
    const actualChainId = await this.chain.getChainIdFromNode();
    if (actualChainId !== expectedChainId) {
      throw new Error(
        `The node reports chainId=${actualChainId} but the deployment manifest ` +
          `declares chainId=${expectedChainId}. RPC_URL points at a different ` +
          `chain than the one the contracts were deployed to.`,
      );
    }

    const providerAddress = this.registry.getProviderAddress();
    const providerCodeSize = await this.assertContractDeployed(
      providerAddress,
      "InsuranceProvider (manifest key insuranceProvider)",
    );

    const oracleAddress = this.registry.getOracleAddress();
    const oracleCodeSize = oracleAddress
      ? await this.assertContractDeployed(
          oracleAddress,
          "weather oracle (manifest oracle key)",
        )
      : undefined;

    await this.assertConstantsMatch();

    const reader = this.contracts.getProviderReader();
    const [blockNumber, coverageReserveWei, premiumBalanceWei] =
      await Promise.all([
        this.chain.call("getBlockNumber", () => provider.getBlockNumber()),
        this.chain.call(
          "coverageReserveWei",
          () => reader.coverageReserveWei() as Promise<bigint>,
        ),
        this.chain.call(
          "premiumBalanceWei",
          () => reader.premiumBalanceWei() as Promise<bigint>,
        ),
      ]);

    const signerAddress = this.chain.getSignerAddress();
    const signerBalanceWei = signerAddress
      ? await this.chain.call("getBalance", () =>
          provider.getBalance(signerAddress),
        )
      : undefined;

    if (signerAddress && signerBalanceWei === 0n) {
      // Not fatal: reads still work, and a funding transaction can arrive at
      // any time. Writes would fail, so it must be visible rather than silent.
      this.logger.warn(
        `Signer ${signerAddress} has a zero balance; policy creation will fail ` +
          `until it is funded for gas.`,
      );
    }

    if (coverageReserveWei === 0n) {
      // The most common first-run surprise: everything is wired correctly, but
      // createPolicy reverts with InsufficientCoverageReserve.
      this.logger.warn(
        "Provider coverage reserve is empty; policy creation will revert with " +
          "InsufficientCoverageReserve until the owner funds it via " +
          "fundCoverageReserve().",
      );
    }

    return {
      verifiedAt: new Date().toISOString(),
      chainId: actualChainId,
      blockNumber,
      providerAddress,
      providerCodeSize,
      oracleAddress,
      oracleCodeSize,
      signerAddress,
      signerBalanceWei: signerBalanceWei?.toString(),
      coverageReserveWei: coverageReserveWei.toString(),
      premiumBalanceWei: premiumBalanceWei.toString(),
    };
  }

  /** Confirms real bytecode exists at an address, returning its size. */
  private async assertContractDeployed(
    address: string,
    label: string,
  ): Promise<number> {
    const code = await this.chain.call(`getCode(${label})`, () =>
      this.chain.getProvider().getCode(address),
    );

    // "0x" means the address holds no code: either an externally owned account,
    // or a manifest left over from a chain that no longer exists.
    if (!code || code === "0x") {
      throw new Error(
        `No contract code found at ${address} for ${label}. The deployment ` +
          `manifest is stale or points at a different chain; redeploy and ` +
          `regenerate contracts/deployments/${this.config.blockchain.network}.json.`,
      );
    }

    return (code.length - 2) / 2;
  }

  /**
   * Compares the constants the API validates against with the ones the contract
   * enforces.
   *
   * `POLICY_DOMAIN` is a hand-maintained mirror. A source-level test guards it
   * against the checked-in contracts, but that says nothing about the contract
   * actually deployed on the target chain, which may be an older build. A
   * mismatch means the API would accept requests that revert, or reject
   * requests that would succeed, so it is fatal.
   */
  private async assertConstantsMatch(): Promise<void> {
    const reader = this.contracts.getProviderReader();
    const mismatches: string[] = [];

    for (const [onChainName, domainKey] of MIRRORED_CONSTANTS) {
      const onChainValue = await this.chain.call(onChainName, () =>
        (reader[onChainName] as () => Promise<bigint>)(),
      );
      const expected = BigInt(POLICY_DOMAIN[domainKey]);

      if (onChainValue !== expected) {
        mismatches.push(
          `${onChainName}: chain=${onChainValue} backend=${expected}`,
        );
      }
    }

    if (mismatches.length > 0) {
      throw new Error(
        `Deployed contract constants do not match POLICY_DOMAIN, so request ` +
          `validation would disagree with what the chain enforces: ` +
          `${mismatches.join("; ")}. Redeploy the current contracts or update ` +
          `POLICY_DOMAIN to match the deployed build.`,
      );
    }
  }

  private logSuccess(verification: ChainVerification): void {
    this.logger.log(
      `Chain verified: chainId=${verification.chainId} ` +
        `block=${verification.blockNumber} ` +
        `provider=${verification.providerAddress} (${verification.providerCodeSize} bytes) ` +
        `oracle=${verification.oracleAddress ?? "none"} ` +
        `signer=${verification.signerAddress ?? "none (reads only)"} ` +
        `coverageReserveWei=${verification.coverageReserveWei}`,
    );
  }
}
