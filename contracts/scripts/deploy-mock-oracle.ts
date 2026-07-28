import { ethers, network } from "hardhat";

/**
 * Deploys `MockWeatherOracle` to a public test network.
 *
 * `deploy.ts` deploys the mock automatically on local networks and demands
 * `EXTERNAL_WEATHER_ORACLE_ADDRESS` everywhere else, which leaves a gap: until
 * Stage 10 wires a real Chainlink oracle there is nothing to point that variable
 * at, so a testnet deployment cannot start. This script fills the gap by
 * deploying an owner-driven oracle whose address can be fed back into the
 * variable.
 *
 * The oracle it deploys is a *mock*: weather data is pushed by its owner rather
 * than observed. That is acceptable on a test network, where the point is to
 * exercise real block times, gas, and RPC behavior, and unacceptable anywhere
 * value is at stake — hence the mainnet guard below.
 */

/** Chain ids where deploying a mock oracle would be a mistake, not a test. */
const FORBIDDEN_CHAIN_IDS = new Map<bigint, string>([
  [1n, "Ethereum Mainnet"],
  [137n, "Polygon Mainnet"],
  [8453n, "Base Mainnet"],
  [42161n, "Arbitrum One"],
  [10n, "OP Mainnet"],
]);

function assertNotProductionChain(chainId: bigint): void {
  const chainName = FORBIDDEN_CHAIN_IDS.get(chainId);
  if (chainName) {
    throw new Error(
      `Refusing to deploy MockWeatherOracle to ${chainName} (chainId ${chainId}). ` +
        `Its weather data is owner-supplied, so it must never back real coverage.`,
    );
  }
}

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();

  assertNotProductionChain(chainId);

  console.log("Network:        ", `${network.name} (chainId ${chainId})`);
  console.log("Deployer:       ", deployer.address);

  const oracleFactory = await ethers.getContractFactory("MockWeatherOracle");
  const oracle = await oracleFactory.deploy(deployer.address);
  await oracle.waitForDeployment();

  const oracleAddress = await oracle.getAddress();
  const deploymentTx = oracle.deploymentTransaction();

  console.log("MockWeatherOracle:", oracleAddress);
  console.log("Transaction:     ", deploymentTx?.hash ?? "unknown");
  console.log("");
  console.log("Add this to contracts/.env, then run the main deployment:");
  console.log("");
  console.log(`  EXTERNAL_WEATHER_ORACLE_ADDRESS=${oracleAddress}`);
  console.log("");
  console.log(
    "Once the provider is deployed, run `npm run oracle:link:sepolia` to point\n" +
      "the oracle at it so policy-provenance checks are active.",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
