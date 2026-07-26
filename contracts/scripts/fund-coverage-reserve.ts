import { promises as fs } from "node:fs";
import path from "node:path";

import { ethers, network } from "hardhat";

/**
 * Funds the deployed provider's coverage reserve.
 *
 * A freshly deployed provider holds no reserve, so every createPolicy call
 * reverts with InsufficientCoverageReserve until an owner funds it. This is the
 * operational step between `deploy` and any policy flow working, and it is
 * owner-only, so it cannot be folded into the backend.
 *
 * Amount comes from COVERAGE_RESERVE_ETH (default 10).
 */

interface DeploymentManifest {
  network: string;
  chainId: string;
  contracts: { insuranceProvider: string };
}

async function readManifest(networkName: string): Promise<DeploymentManifest> {
  const manifestPath = path.resolve(__dirname, "..", "deployments", `${networkName}.json`);

  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(raw) as DeploymentManifest;
  } catch {
    throw new Error(`No deployment manifest at ${manifestPath}. Deploy to "${networkName}" first.`);
  }
}

async function main(): Promise<void> {
  const manifest = await readManifest(network.name);
  const amountEth = process.env.COVERAGE_RESERVE_ETH ?? "10";
  const amountWei = ethers.parseEther(amountEth);

  const [signer] = await ethers.getSigners();
  const provider = await ethers.getContractAt(
    "InsuranceProvider",
    manifest.contracts.insuranceProvider,
    signer,
  );

  const owner = await provider.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `fundCoverageReserve is owner-only. Provider owner is ${owner} but the ` +
        `configured signer is ${signer.address}.`,
    );
  }

  const before = await provider.coverageReserveWei();
  const tx = await provider.fundCoverageReserve({ value: amountWei });
  const receipt = await tx.wait();
  const after = await provider.coverageReserveWei();

  console.log(`Provider:        ${manifest.contracts.insuranceProvider}`);
  console.log(`Network:         ${network.name} (chainId ${manifest.chainId})`);
  console.log(`Funded:          ${amountEth} ETH`);
  console.log(`Reserve before:  ${ethers.formatEther(before)} ETH`);
  console.log(`Reserve after:   ${ethers.formatEther(after)} ETH`);
  console.log(`Transaction:     ${receipt?.hash}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
