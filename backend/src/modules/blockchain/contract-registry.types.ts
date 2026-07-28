/** Entry in the shared ABI index (`shared/abi/index.json`). */
export interface AbiIndexEntry {
  contractName: string;
  sourceName: string;
  file: string;
}

/** Shape of the shared ABI index document. */
export interface AbiIndex {
  schemaVersion: number;
  contracts: AbiIndexEntry[];
}

/** A single fragment of a contract ABI. */
export type AbiFragment = Record<string, unknown>;

/** Shape of a per-contract ABI artifact (`shared/abi/<Contract>.json`). */
export interface AbiArtifact {
  schemaVersion: number;
  contractName: string;
  sourceName: string;
  abi: AbiFragment[];
}

/** Shape of a per-network deployment manifest (`contracts/deployments/<network>.json`). */
export interface DeploymentManifest {
  schemaVersion: number;
  generatedAt?: string;
  network: string;
  chainId: string;
  deployer?: string;
  contracts: Record<string, string>;
  /**
   * keccak256 of the runtime bytecode deployed at each address, by manifest key.
   *
   * Optional because manifests written before this field exist. Boot
   * verification says so out loud rather than treating its absence as a pass.
   */
  runtimeBytecodeHashes?: Record<string, string>;
}

/**
 * Immutable, serializable summary of the loaded integration metadata.
 * Surfaced by the readiness probe and the blockchain describe endpoint.
 */
export interface ContractRegistrySnapshot {
  network: string;
  chainId: string;
  providerAddress: string;
  oracleAddress?: string;
  providerAddressSource: "manifest" | "config-override";
  loadedContracts: string[];
  sharedAbiDir: string;
  deploymentsDir: string;
  manifestFile: string;
}

/** Contracts whose ABIs the backend must be able to load to operate. */
export const REQUIRED_CONTRACTS = [
  "InsuranceProvider",
  "InsurancePolicy",
] as const;

/** Manifest key holding the provider/factory contract address. */
export const PROVIDER_MANIFEST_KEY = "insuranceProvider";

/** Manifest keys (in priority order) that may hold the weather oracle address. */
export const ORACLE_MANIFEST_KEYS = ["weatherOracle", "mockWeatherOracle"];
