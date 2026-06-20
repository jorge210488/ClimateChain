import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

import { AppConfigService } from "../../config/app-config.service";
import {
  AbiArtifact,
  AbiFragment,
  AbiIndex,
  ContractRegistrySnapshot,
  DeploymentManifest,
  ORACLE_MANIFEST_KEYS,
  PROVIDER_MANIFEST_KEY,
  REQUIRED_CONTRACTS,
} from "./contract-registry.types";
import { assertUsableAddress } from "../../common/utils/evm-address.util";

/**
 * Loads and validates the on-chain integration metadata produced by Stage 04:
 * the shared ABI bundle (`shared/abi`) and the per-network deployment manifest
 * (`contracts/deployments/<network>.json`).
 *
 * Validation runs on module init and is fail-fast: any missing, malformed, or
 * inconsistent artifact aborts application boot with an actionable diagnostic.
 * Stage 06 consumes the loaded ABIs and addresses to build the live ethers
 * client; this stage owns the metadata contract only (no RPC calls).
 */
@Injectable()
export class ContractRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ContractRegistryService.name);
  private readonly abis = new Map<string, AbiFragment[]>();
  private manifest?: DeploymentManifest;
  private snapshot?: ContractRegistrySnapshot;
  private ready = false;

  constructor(private readonly config: AppConfigService) {}

  onModuleInit(): void {
    this.load();
  }

  /**
   * Loads and validates all integration metadata. Throws on any failure so the
   * application fails fast at boot rather than serving with broken integration.
   */
  load(): void {
    const { sharedAbiDir, deploymentsDir, network, chainId, factoryAddress } =
      this.config.blockchain;

    try {
      this.loadAbis(sharedAbiDir);
      const { manifest, manifestFile } = this.loadManifest(
        deploymentsDir,
        network,
      );

      if (chainId !== undefined && String(chainId) !== manifest.chainId) {
        throw new Error(
          `Configured CHAIN_ID=${chainId} does not match manifest chainId=${manifest.chainId} for network "${network}"`,
        );
      }

      const providerAddressSource: ContractRegistrySnapshot["providerAddressSource"] =
        factoryAddress ? "config-override" : "manifest";
      const providerAddress = assertUsableAddress(
        factoryAddress ?? manifest.contracts[PROVIDER_MANIFEST_KEY],
        factoryAddress
          ? "FACTORY_ADDRESS override"
          : `manifest contract "${PROVIDER_MANIFEST_KEY}"`,
      );
      const oracleAddress = this.resolveOracleAddress(manifest, manifestFile);

      this.manifest = manifest;
      this.snapshot = {
        network: manifest.network,
        chainId: manifest.chainId,
        providerAddress,
        oracleAddress,
        providerAddressSource,
        loadedContracts: [...this.abis.keys()],
        sharedAbiDir,
        deploymentsDir,
        manifestFile,
      };
      this.ready = true;

      this.logger.log(
        `Contract registry ready: network=${manifest.network} ` +
          `chainId=${manifest.chainId} provider=${providerAddress} ` +
          `(${providerAddressSource}); ABIs=[${[...this.abis.keys()].join(", ")}]`,
      );
    } catch (error) {
      this.ready = false;
      this.snapshot = undefined;
      this.manifest = undefined;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load blockchain integration metadata. ${message}. ` +
          `Verify SHARED_ABI_DIR (${sharedAbiDir}) and ` +
          `CONTRACTS_DEPLOYMENTS_DIR (${deploymentsDir}) point to Stage 04 ` +
          `outputs and that BLOCKCHAIN_NETWORK="${network}" has a deployment manifest.`,
      );
    }
  }

  private loadAbis(sharedAbiDir: string): void {
    this.abis.clear();
    const indexPath = join(sharedAbiDir, "index.json");
    const index = this.readJson<AbiIndex>(indexPath, "shared ABI index");

    if (
      typeof index.schemaVersion !== "number" ||
      !Array.isArray(index.contracts)
    ) {
      throw new Error(
        `Malformed ABI index at ${indexPath} (expected { schemaVersion, contracts[] })`,
      );
    }

    for (const contractName of REQUIRED_CONTRACTS) {
      const entry = index.contracts.find(
        (candidate) => candidate.contractName === contractName,
      );
      if (!entry) {
        throw new Error(
          `Required contract "${contractName}" is missing from ABI index ${indexPath}`,
        );
      }

      const artifactPath = join(sharedAbiDir, entry.file);
      const artifact = this.readJson<AbiArtifact>(
        artifactPath,
        `ABI artifact for ${contractName}`,
      );

      if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
        throw new Error(
          `ABI artifact ${artifactPath} for "${contractName}" has no usable abi array`,
        );
      }
      if (artifact.contractName !== contractName) {
        throw new Error(
          `ABI artifact ${artifactPath} declares contractName ` +
            `"${artifact.contractName}" but was indexed as "${contractName}"`,
        );
      }

      this.abis.set(contractName, artifact.abi);
    }
  }

  private loadManifest(
    deploymentsDir: string,
    network: string,
  ): { manifest: DeploymentManifest; manifestFile: string } {
    const manifestFile = join(deploymentsDir, `${network}.json`);
    const manifest = this.readJson<DeploymentManifest>(
      manifestFile,
      `deployment manifest for network "${network}"`,
    );

    if (typeof manifest.schemaVersion !== "number") {
      throw new Error(
        `Malformed deployment manifest at ${manifestFile} (missing schemaVersion)`,
      );
    }
    if (typeof manifest.chainId !== "string" || manifest.chainId.length === 0) {
      throw new Error(
        `Deployment manifest ${manifestFile} is missing a string chainId`,
      );
    }
    if (!manifest.contracts || typeof manifest.contracts !== "object") {
      throw new Error(
        `Deployment manifest ${manifestFile} is missing a contracts map`,
      );
    }
    if (manifest.network !== network) {
      throw new Error(
        `Deployment manifest ${manifestFile} declares network ` +
          `"${manifest.network}" but was loaded for "${network}"`,
      );
    }

    return { manifest, manifestFile };
  }

  private resolveOracleAddress(
    manifest: DeploymentManifest,
    manifestFile: string,
  ): string | undefined {
    for (const key of ORACLE_MANIFEST_KEYS) {
      const candidate = manifest.contracts[key];
      // Absent or explicitly empty: the oracle is optional, so treat it as
      // "not configured" and try the next candidate key.
      if (typeof candidate !== "string" || candidate.trim().length === 0) {
        continue;
      }
      // Present and non-empty: the operator intended to wire an oracle here,
      // so a malformed or zero address is a deployment mistake. Fail fast
      // instead of silently degrading to no oracle (which Stage 06 would
      // then run with). assertUsableAddress throws with an actionable message.
      return assertUsableAddress(
        candidate,
        `manifest oracle address "${key}" in ${manifestFile}`,
      );
    }
    return undefined;
  }

  private readJson<T>(path: string, label: string): T {
    if (!existsSync(path)) {
      throw new Error(`Missing ${label}: file not found at ${path}`);
    }

    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (error) {
      throw new Error(
        `Unable to read ${label} at ${path}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${label} at ${path}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // --- Accessors consumed by health checks and Stage 06 live integration ---

  isReady(): boolean {
    return this.ready;
  }

  getSnapshot(): ContractRegistrySnapshot {
    if (!this.snapshot) {
      throw new Error("Contract registry is not initialized");
    }
    return this.snapshot;
  }

  hasAbi(contractName: string): boolean {
    return this.abis.has(contractName);
  }

  getAbi(contractName: string): AbiFragment[] {
    const abi = this.abis.get(contractName);
    if (!abi) {
      throw new Error(`ABI for contract "${contractName}" is not loaded`);
    }
    return abi;
  }

  getProviderAddress(): string {
    return this.getSnapshot().providerAddress;
  }

  getOracleAddress(): string | undefined {
    return this.getSnapshot().oracleAddress;
  }

  getNetwork(): string {
    return this.getSnapshot().network;
  }

  getChainId(): string {
    return this.getSnapshot().chainId;
  }

  getManifest(): DeploymentManifest {
    if (!this.manifest) {
      throw new Error("Deployment manifest is not loaded");
    }
    return this.manifest;
  }
}
