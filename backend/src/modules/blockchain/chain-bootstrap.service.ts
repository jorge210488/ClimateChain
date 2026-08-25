import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { keccak256 } from "ethers";

import { LEGACY_REGION_CODE } from "../../common/utils/region-code.util";
import { AppConfigService } from "../../config/app-config.service";
import { POLICY_DOMAIN } from "../policies/policy.constants";
import { ChainProviderService } from "./chain-provider.service";
import { ContractFactoryService } from "./contract-factory.service";
import { ContractRegistryService } from "./contract-registry.service";
import {
  ORACLE_MANIFEST_KEYS,
  PROVIDER_MANIFEST_KEY,
} from "./contract-registry.types";

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

/**
 * How long a deployment-identity check is trusted before being redone.
 *
 * Short enough that drift is caught in seconds, long enough that a probe
 * hammering `eth_getCode` does not become its own load problem.
 */
const IDENTITY_RECHECK_TTL_MS = 30_000;

/** On-chain constants mirrored by `POLICY_DOMAIN`, read back for comparison. */
const MIRRORED_CONSTANTS = [
  ["MAX_DURATION_DAYS", "maxDurationDays"],
  ["MIN_PREMIUM_BPS", "minPremiumBps"],
  ["BASIS_POINTS_DENOMINATOR", "basisPointsDenominator"],
  ["MIN_POLICY_START_LEAD_TIME_SECONDS", "minPolicyStartLeadTimeSeconds"],
  ["MAX_POLICY_START_LEAD_TIME_SECONDS", "maxPolicyStartLeadTimeSeconds"],
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
  private driftCheckedAt?: number;
  private lastDriftReason?: string;

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
      PROVIDER_MANIFEST_KEY,
    );

    const oracleAddress = this.registry.getOracleAddress();
    const oracleCodeSize = oracleAddress
      ? await this.assertContractDeployed(
          oracleAddress,
          "weather oracle (manifest oracle key)",
          this.resolveOracleManifestKey(),
        )
      : undefined;

    await this.assertConstantsMatch();
    await this.assertLegacyRegionCodeMatches();

    const reader = this.contracts.getProviderReader();
    const [blockNumber, coverageReserveWei, premiumBalanceWei] =
      await Promise.all([
        // Asked of the node, not read from the provider's polling cache, so the
        // recorded height reflects the chain this actually verified against.
        this.chain.getBlockNumberFromNode(),
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

  /**
   * Confirms the address holds the bytecode the manifest says it should.
   *
   * Presence alone is a weak check: *any* contract has code, so an address
   * pointing at something entirely different passes it. Comparing the runtime
   * bytecode hash against the value recorded at deployment is what makes this
   * verification of identity rather than of existence.
   *
   * @param manifestKey Key under which the manifest records this contract's hash.
   * @returns Size of the deployed bytecode in bytes.
   */
  private async assertContractDeployed(
    address: string,
    label: string,
    manifestKey: string,
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

    this.assertBytecodeIdentity(address, label, manifestKey, code);

    return (code.length - 2) / 2;
  }

  /**
   * Re-checks, at most once per {@link IDENTITY_RECHECK_TTL_MS}, that the
   * contracts are still the ones verified at boot.
   *
   * Boot proves the chain was right *then*. Readiness currently proves the node
   * answers and reports the same chain id, which misses the failure that is
   * easiest to hit: a local node restarted from scratch keeps chain id 31337 and
   * loses every contract, and an RPC failing over to a fork can do the same on a
   * public network. Readiness stays green while every address is empty.
   *
   * Cached because a probe runs often and this costs one `eth_getCode` per
   * contract. Fails closed — a check that cannot complete is reported as drift
   * rather than assumed healthy.
   *
   * @returns A reason when the deployment no longer matches, undefined when it does.
   */
  async detectDeploymentDrift(): Promise<string | undefined> {
    const now = Date.now();
    if (
      this.driftCheckedAt !== undefined &&
      now - this.driftCheckedAt < IDENTITY_RECHECK_TTL_MS
    ) {
      return this.lastDriftReason;
    }

    const verification = this.verification;
    if (!verification) {
      return "Chain verification did not complete at startup";
    }

    try {
      const targets: Array<[string, string, string]> = [
        [
          verification.providerAddress,
          "InsuranceProvider",
          PROVIDER_MANIFEST_KEY,
        ],
      ];
      if (verification.oracleAddress) {
        targets.push([
          verification.oracleAddress,
          "weather oracle",
          this.resolveOracleManifestKey(),
        ]);
      }

      let reason: string | undefined;
      for (const [address, label, manifestKey] of targets) {
        const code = await this.chain.call(`getCode(${label})`, () =>
          this.chain.getProvider().getCode(address),
        );

        if (!code || code === "0x") {
          reason =
            `${label} at ${address} no longer holds any code. The node was ` +
            `reset or replaced since startup.`;
          break;
        }

        const expected =
          this.registry.getManifest().runtimeBytecodeHashes?.[manifestKey];
        if (expected && keccak256(code) !== expected) {
          reason =
            `${label} at ${address} holds different bytecode than at startup. ` +
            `The endpoint points at a different deployment.`;
          break;
        }
      }

      this.driftCheckedAt = now;
      this.lastDriftReason = reason;
      return reason;
    } catch (error) {
      // Fail closed: an unanswerable check is not a passing one. Not cached,
      // so a transient failure is retried on the next probe.
      return `Could not re-verify the deployment: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  /**
   * Names the manifest key the oracle address was actually resolved from.
   *
   * The registry accepts either `weatherOracle` or `mockWeatherOracle`, so the
   * hash has to be looked up under whichever one supplied the address rather
   * than under a guess.
   */
  private resolveOracleManifestKey(): string {
    const manifest = this.registry.getManifest();
    const oracleAddress = this.registry.getOracleAddress();

    return (
      ORACLE_MANIFEST_KEYS.find(
        (key) => manifest.contracts[key] === oracleAddress,
      ) ?? ORACLE_MANIFEST_KEYS[0]
    );
  }

  /**
   * Fails when the deployed code is not the code that was deployed.
   *
   * A manifest can point at a live contract that is simply the wrong one — an
   * older provider left on the chain, a redeploy nobody regenerated the manifest
   * for, an address pasted from another network. Every one of those passes a
   * "code exists" check and then misbehaves at the first call, usually as an
   * inscrutable decoding error rather than a configuration problem.
   *
   * Absence of a recorded hash is reported, not tolerated silently: a manifest
   * written before this field existed cannot be verified, and pretending
   * otherwise would be worse than the original weak check.
   */
  private assertBytecodeIdentity(
    address: string,
    label: string,
    manifestKey: string,
    code: string,
  ): void {
    const expectedHash =
      this.registry.getManifest().runtimeBytecodeHashes?.[manifestKey];

    if (!expectedHash) {
      const explanation =
        `No runtime bytecode hash recorded for "${manifestKey}" in the ` +
        `deployment manifest, so ${label} at ${address} can only be verified ` +
        `to hold *some* code. Redeploy to record it.`;

      // Deployed profiles must not run on an unverifiable manifest: the whole
      // point of the hash is to catch an address holding a different contract,
      // and downgrading that to a log line where it matters most would make the
      // check decorative. Local profiles keep the warning, so a manifest
      // predating the field still runs.
      if (this.config.isDeployedProfile) {
        throw new Error(
          `${explanation} Deployed profiles require it: without a recorded ` +
            `hash the address is not verified to hold the expected contract.`,
        );
      }

      this.logger.warn(explanation);
      return;
    }

    const actualHash = keccak256(code);
    if (actualHash !== expectedHash) {
      throw new Error(
        `Bytecode at ${address} does not match the deployment manifest for ` +
          `${label}: expected ${expectedHash}, found ${actualHash}. The address ` +
          `holds a different contract than the one deployed; redeploy and ` +
          `regenerate contracts/deployments/${this.config.blockchain.network}.json.`,
      );
    }
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

  /**
   * Confirms the placeholder region the backend sends matches the contract's.
   *
   * A request without a region still goes through the beneficiary-aware entry
   * point, which requires a non-zero region code, so the backend substitutes
   * the contract's own `LEGACY_REGION_CODE`. If the two ever diverged those
   * policies would be filed under a code nothing else recognizes — readable,
   * but invisible to any consumer filtering on the real one.
   */
  private async assertLegacyRegionCodeMatches(): Promise<void> {
    const reader = this.contracts.getProviderReader();
    const onChain = await this.chain.call(
      "LEGACY_REGION_CODE",
      () => reader.LEGACY_REGION_CODE() as Promise<string>,
    );

    if (onChain.toLowerCase() !== LEGACY_REGION_CODE.toLowerCase()) {
      throw new Error(
        `Deployed LEGACY_REGION_CODE is ${onChain} but the backend mirrors ` +
          `${LEGACY_REGION_CODE}. Policies created without an explicit region ` +
          `would be filed under a code the contract does not use.`,
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
