import { promises as fs } from "node:fs";
import path from "node:path";

import { ethers, network } from "hardhat";

interface DeploymentManifest {
  schemaVersion: number;
  generatedAt: string;
  network: string;
  chainId: string;
  deployer: string;
  contracts: {
    weatherOracle: string;
    mockWeatherOracle?: string;
    insuranceProvider: string;
  };
}

function resolveExternalOracleAddress(networkName: string): string {
  const configuredAddress = process.env.EXTERNAL_WEATHER_ORACLE_ADDRESS;
  if (!configuredAddress) {
    throw new Error(`EXTERNAL_WEATHER_ORACLE_ADDRESS is required for ${networkName} deployments`);
  }

  if (!ethers.isAddress(configuredAddress) || configuredAddress === ethers.ZeroAddress) {
    throw new Error(
      `EXTERNAL_WEATHER_ORACLE_ADDRESS must be a valid non-zero address for ${networkName}`,
    );
  }

  return configuredAddress;
}

async function writeDeploymentManifest(manifest: DeploymentManifest): Promise<string> {
  const deploymentsDir = path.resolve(__dirname, "..", "deployments");
  await fs.mkdir(deploymentsDir, { recursive: true });

  const manifestPath = path.join(deploymentsDir, `${manifest.network}.json`);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return manifestPath;
}

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const networkDetails = await ethers.provider.getNetwork();
  const isLocalNetwork = network.name === "hardhat" || network.name === "localhost";

  console.log("Deploying contracts with account:", deployer.address);

  let oracleAddress: string;
  let mockWeatherOracleAddress: string | undefined;

  if (isLocalNetwork) {
    const oracleFactory = await ethers.getContractFactory("MockWeatherOracle");
    const oracle = await oracleFactory.deploy(deployer.address);
    await oracle.waitForDeployment();

    mockWeatherOracleAddress = await oracle.getAddress();
    oracleAddress = mockWeatherOracleAddress;
    console.log("MockWeatherOracle deployed at:", oracleAddress);
  } else {
    oracleAddress = resolveExternalOracleAddress(network.name);
    console.log("Using external weather oracle at:", oracleAddress);
  }

  const providerFactory = await ethers.getContractFactory("InsuranceProvider");
  const insuranceProvider = await providerFactory.deploy(deployer.address, oracleAddress);
  await insuranceProvider.waitForDeployment();

  const providerAddress = await insuranceProvider.getAddress();
  console.log("InsuranceProvider deployed at:", providerAddress);

  const manifest: DeploymentManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    network: network.name,
    chainId: networkDetails.chainId.toString(),
    deployer: deployer.address,
    contracts: {
      weatherOracle: oracleAddress,
      ...(mockWeatherOracleAddress ? { mockWeatherOracle: mockWeatherOracleAddress } : {}),
      insuranceProvider: providerAddress,
    },
  };

  const manifestPath = await writeDeploymentManifest(manifest);
  console.log("Deployment manifest written to:", manifestPath);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
