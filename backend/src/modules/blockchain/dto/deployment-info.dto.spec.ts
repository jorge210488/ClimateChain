import { ContractRegistrySnapshot } from "../contract-registry.types";
import { DeploymentInfoResponse } from "./deployment-info.dto";

const SNAPSHOT: ContractRegistrySnapshot = {
  network: "hardhat",
  chainId: "31337",
  providerAddress: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  oracleAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  providerAddressSource: "manifest",
  loadedContracts: ["InsuranceProvider", "InsurancePolicy"],
  sharedAbiDir: "/abi",
  deploymentsDir: "/deployments",
  manifestFile: "/deployments/hardhat.json",
};

describe("DeploymentInfoResponse.fromSnapshot", () => {
  it("includes providerAddressSource by default", () => {
    const response = DeploymentInfoResponse.fromSnapshot(SNAPSHOT);

    expect(response.providerAddressSource).toBe("manifest");
  });

  it("includes providerAddressSource when explicitly requested", () => {
    const response = DeploymentInfoResponse.fromSnapshot(SNAPSHOT, {
      includeProviderAddressSource: true,
    });

    expect(response.providerAddressSource).toBe("manifest");
  });

  it("omits providerAddressSource on deployed profiles", () => {
    const response = DeploymentInfoResponse.fromSnapshot(SNAPSHOT, {
      includeProviderAddressSource: false,
    });

    expect(response.providerAddressSource).toBeUndefined();
    expect(response).not.toHaveProperty("providerAddressSource");
    // The publicly relevant on-chain fields remain present.
    expect(response.providerAddress).toBe(SNAPSHOT.providerAddress);
    expect(response.oracleAddress).toBe(SNAPSHOT.oracleAddress);
    expect(response.network).toBe("hardhat");
  });
});
