import { promises as fs } from "node:fs";
import path from "node:path";

import { ethers, network } from "hardhat";

/**
 * Points a deployed `MockWeatherOracle` at the provider that owns its policies.
 *
 * `deploy.ts` does this inline on local networks. On a public test network the
 * oracle is deployed first — the provider's constructor needs its address — so
 * the link can only be made afterwards, from the manifest that deployment
 * writes.
 *
 * Without the link the oracle still works, but it accepts a push for any
 * address: `_assertValidPolicyAddress` only checks provenance when
 * `policyRegistry` is set. Running this is what makes that check active.
 */

interface DeploymentManifest {
  network: string;
  chainId: string;
  contracts: {
    weatherOracle: string;
    insuranceProvider: string;
  };
}

async function readDeploymentManifest(networkName: string): Promise<DeploymentManifest> {
  const manifestPath = path.resolve(__dirname, "..", "deployments", `${networkName}.json`);

  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw new Error(
      `No deployment manifest at ${manifestPath}. Deploy the provider first ` +
        `(npm run deploy:${networkName}).`,
    );
  }

  return JSON.parse(raw) as DeploymentManifest;
}

async function main(): Promise<void> {
  const [signer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const manifest = await readDeploymentManifest(network.name);

  if (manifest.chainId !== chainId.toString()) {
    throw new Error(
      `Manifest was written for chainId ${manifest.chainId} but the current ` +
        `network is ${chainId}. Redeploy before linking.`,
    );
  }

  const { weatherOracle, insuranceProvider } = manifest.contracts;
  console.log("Network:        ", `${network.name} (chainId ${chainId})`);
  console.log("Oracle:         ", weatherOracle);
  console.log("Provider:       ", insuranceProvider);

  const oracle = await ethers.getContractAt("MockWeatherOracle", weatherOracle);

  // A non-mock oracle has no such owner, so this doubles as a check that the
  // manifest really points at the mock this script knows how to configure.
  const oracleOwner = await oracle.owner();
  if (oracleOwner !== signer.address) {
    throw new Error(
      `The oracle is owned by ${oracleOwner}, not by the configured signer ` +
        `${signer.address}. Only its owner can set the policy registry.`,
    );
  }

  const currentRegistry = await oracle.policyRegistry();
  if (currentRegistry === insuranceProvider) {
    console.log("Already linked; nothing to do.");
    return;
  }

  const tx = await oracle.setPolicyRegistry(insuranceProvider);
  const receipt = await tx.wait();

  console.log("Linked in tx:   ", receipt?.hash ?? tx.hash);
  console.log("Provenance checks are now active for pushes to unknown policies.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
