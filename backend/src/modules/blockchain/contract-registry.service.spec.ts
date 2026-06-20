import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AppConfigService } from "../../config/app-config.service";
import { BlockchainConfig } from "../../config/config.types";
import { ContractRegistryService } from "./contract-registry.service";

const REPO_SHARED_ABI = resolve(process.cwd(), "..", "shared", "abi");
const REPO_DEPLOYMENTS = resolve(
  process.cwd(),
  "..",
  "contracts",
  "deployments",
);

function buildConfig(
  overrides: Partial<BlockchainConfig> = {},
): AppConfigService {
  const blockchain: BlockchainConfig = {
    network: "hardhat",
    sharedAbiDir: REPO_SHARED_ABI,
    deploymentsDir: REPO_DEPLOYMENTS,
    ...overrides,
  };
  return { blockchain } as AppConfigService;
}

describe("ContractRegistryService", () => {
  it("loads ABIs and the provider address from the hardhat manifest", () => {
    const service = new ContractRegistryService(buildConfig());

    service.load();

    expect(service.isReady()).toBe(true);
    const snapshot = service.getSnapshot();
    expect(snapshot.network).toBe("hardhat");
    expect(snapshot.chainId).toBe("31337");
    expect(snapshot.providerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(snapshot.providerAddressSource).toBe("manifest");
    expect(snapshot.loadedContracts).toEqual(
      expect.arrayContaining(["InsuranceProvider", "InsurancePolicy"]),
    );
    expect(service.getAbi("InsuranceProvider").length).toBeGreaterThan(0);
    expect(service.getAbi("InsurancePolicy").length).toBeGreaterThan(0);
  });

  it("honors the FACTORY_ADDRESS override", () => {
    const override = "0x1111111111111111111111111111111111111111";
    const service = new ContractRegistryService(
      buildConfig({ factoryAddress: override }),
    );

    service.load();

    const snapshot = service.getSnapshot();
    expect(snapshot.providerAddress).toBe(override);
    expect(snapshot.providerAddressSource).toBe("config-override");
  });

  it("fails fast when the configured chain id mismatches the manifest", () => {
    const service = new ContractRegistryService(buildConfig({ chainId: 999 }));

    expect(() => service.load()).toThrow(/does not match manifest chainId/);
    expect(service.isReady()).toBe(false);
  });

  it("fails fast when the deployment manifest is missing", () => {
    const service = new ContractRegistryService(
      buildConfig({ network: "nonexistent-network" }),
    );

    expect(() => service.load()).toThrow(
      /Failed to load blockchain integration metadata/,
    );
    expect(service.isReady()).toBe(false);
  });

  it("fails fast when the shared ABI directory has no index", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "climatechain-abi-empty-"));
    try {
      const service = new ContractRegistryService(
        buildConfig({ sharedAbiDir: emptyDir }),
      );
      expect(() => service.load()).toThrow(/shared ABI index/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("fails fast when a present oracle address is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "climatechain-bad-oracle-"));
    try {
      writeFileSync(
        join(dir, "badoracle.json"),
        JSON.stringify({
          schemaVersion: 1,
          network: "badoracle",
          chainId: "31337",
          contracts: {
            weatherOracle: "0xnot-a-valid-address",
            insuranceProvider: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
          },
        }),
      );
      const service = new ContractRegistryService(
        buildConfig({ network: "badoracle", deploymentsDir: dir }),
      );

      expect(() => service.load()).toThrow(/oracle address/);
      expect(service.isReady()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an absent oracle address as no oracle configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "climatechain-no-oracle-"));
    try {
      writeFileSync(
        join(dir, "nooracle.json"),
        JSON.stringify({
          schemaVersion: 1,
          network: "nooracle",
          chainId: "31337",
          contracts: {
            insuranceProvider: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
          },
        }),
      );
      const service = new ContractRegistryService(
        buildConfig({ network: "nooracle", deploymentsDir: dir }),
      );

      service.load();

      expect(service.isReady()).toBe(true);
      expect(service.getOracleAddress()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
