import { promises as fs } from "node:fs";
import path from "node:path";

import { ethers, network } from "hardhat";
import type { ContractTransactionReceipt, Interface } from "ethers";

interface DeploymentManifest {
  contracts?: {
    insuranceProvider?: string;
  };
}

interface HarnessOptions {
  totalPolicies: number;
  burstSize: number;
  insuredAccounts: number;
  coverageWei: bigint;
  premiumBps: number;
  rainfallThresholdMm: number;
  durationDays: number;
  forceFreshDeployment: boolean;
}

const BASIS_POINTS_DENOMINATOR = 10_000n;

function parsePositiveInteger(
  rawValue: string | undefined,
  fallbackValue: number,
  optionName: string,
): number {
  const parsedValue = Number(rawValue ?? String(fallbackValue));

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsedValue;
}

function parseBoolean(
  rawValue: string | undefined,
  fallbackValue: boolean,
  optionName: string,
): boolean {
  if (rawValue === undefined) {
    return fallbackValue;
  }

  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  throw new Error(`${optionName} must be either 'true' or 'false'.`);
}

function parseCoverageWei(rawCoverageEth: string | undefined): bigint {
  const normalizedCoverageEth = rawCoverageEth ?? "0.2";

  let coverageWei: bigint;
  try {
    coverageWei = ethers.parseEther(normalizedCoverageEth);
  } catch {
    throw new Error(
      "STRESS_COVERAGE_ETH must be a valid decimal ETH value (for example: 0.2, 1, 2.5).",
    );
  }

  if (coverageWei === 0n) {
    throw new Error("STRESS_COVERAGE_ETH must be greater than zero (value cannot be 0).");
  }

  return coverageWei;
}

function loadHarnessOptions(): HarnessOptions {
  const totalPolicies = parsePositiveInteger(
    process.env.STRESS_POLICIES_COUNT,
    20,
    "STRESS_POLICIES_COUNT",
  );
  const burstSize = parsePositiveInteger(process.env.STRESS_BURST_SIZE, 5, "STRESS_BURST_SIZE");
  const insuredAccounts = parsePositiveInteger(
    process.env.STRESS_INSURED_ACCOUNTS,
    5,
    "STRESS_INSURED_ACCOUNTS",
  );
  const coverageWei = parseCoverageWei(process.env.STRESS_COVERAGE_ETH);
  const premiumBps = parsePositiveInteger(
    process.env.STRESS_PREMIUM_BPS,
    125,
    "STRESS_PREMIUM_BPS",
  );
  const rainfallThresholdMm = parsePositiveInteger(
    process.env.STRESS_RAINFALL_THRESHOLD_MM,
    30,
    "STRESS_RAINFALL_THRESHOLD_MM",
  );
  const durationDays = parsePositiveInteger(
    process.env.STRESS_DURATION_DAYS,
    14,
    "STRESS_DURATION_DAYS",
  );
  const forceFreshDeployment = parseBoolean(
    process.env.STRESS_FORCE_DEPLOY,
    false,
    "STRESS_FORCE_DEPLOY",
  );

  if (burstSize > insuredAccounts) {
    throw new Error(
      "STRESS_BURST_SIZE must be less than or equal to STRESS_INSURED_ACCOUNTS to avoid signer nonce contention in a burst.",
    );
  }

  return {
    totalPolicies,
    burstSize,
    insuredAccounts,
    coverageWei,
    premiumBps,
    rainfallThresholdMm,
    durationDays,
    forceFreshDeployment,
  };
}

async function readDeploymentManifest(networkName: string): Promise<DeploymentManifest | null> {
  const manifestPath = path.resolve(__dirname, "..", "deployments", `${networkName}.json`);

  try {
    const rawManifest = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(rawManifest) as DeploymentManifest;
  } catch {
    return null;
  }
}

async function hasBytecode(addressToCheck: string): Promise<boolean> {
  const code = await ethers.provider.getCode(addressToCheck);
  return code !== "0x";
}

async function deployLocalStack(
  ownerAddress: string,
): Promise<{ providerAddress: string; oracleAddress: string }> {
  const oracleFactory = await ethers.getContractFactory("MockWeatherOracle");
  const oracle = await oracleFactory.deploy(ownerAddress);
  await oracle.waitForDeployment();

  const oracleAddress = await oracle.getAddress();

  const providerFactory = await ethers.getContractFactory("InsuranceProvider");
  const provider = await providerFactory.deploy(ownerAddress, oracleAddress);
  await provider.waitForDeployment();

  const providerAddress = await provider.getAddress();

  const setRegistryTx = await oracle.setPolicyRegistry(providerAddress);
  await setRegistryTx.wait();

  return { providerAddress, oracleAddress };
}

async function resolveProviderAddress(
  options: HarnessOptions,
  ownerAddress: string,
): Promise<string> {
  if (options.forceFreshDeployment) {
    const deployment = await deployLocalStack(ownerAddress);
    console.log(
      `STRESS_FORCE_DEPLOY=true, deployed fresh local stack (provider: ${deployment.providerAddress}, oracle: ${deployment.oracleAddress}).`,
    );
    return deployment.providerAddress;
  }

  const explicitProviderAddress = process.env.STRESS_PROVIDER_ADDRESS;
  if (explicitProviderAddress) {
    if (
      !ethers.isAddress(explicitProviderAddress) ||
      explicitProviderAddress === ethers.ZeroAddress
    ) {
      throw new Error("STRESS_PROVIDER_ADDRESS must be a valid non-zero address.");
    }

    if (!(await hasBytecode(explicitProviderAddress))) {
      throw new Error(
        `STRESS_PROVIDER_ADDRESS ${explicitProviderAddress} has no bytecode on network '${network.name}'.`,
      );
    }

    console.log(
      `Using explicit provider address from STRESS_PROVIDER_ADDRESS: ${explicitProviderAddress}`,
    );
    return explicitProviderAddress;
  }

  const deploymentManifest = await readDeploymentManifest(network.name);
  const manifestProviderAddress = deploymentManifest?.contracts?.insuranceProvider;

  if (
    manifestProviderAddress &&
    ethers.isAddress(manifestProviderAddress) &&
    manifestProviderAddress !== ethers.ZeroAddress &&
    (await hasBytecode(manifestProviderAddress))
  ) {
    console.log(`Using provider from deployments/${network.name}.json: ${manifestProviderAddress}`);
    return manifestProviderAddress;
  }

  const deployment = await deployLocalStack(ownerAddress);
  console.log(
    `No reusable provider deployment found for network '${network.name}', deployed fresh local stack (provider: ${deployment.providerAddress}, oracle: ${deployment.oracleAddress}).`,
  );
  return deployment.providerAddress;
}

function extractPolicyAddressFromReceipt(
  providerAddressLowerCase: string,
  providerInterface: Interface,
  receipt: ContractTransactionReceipt,
): string | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== providerAddressLowerCase) {
      continue;
    }

    try {
      const parsedLog = providerInterface.parseLog(log);

      if (!parsedLog || parsedLog.name !== "PolicyCreated") {
        continue;
      }

      const policyAddress = parsedLog.args["policyAddress"];
      if (typeof policyAddress === "string" && ethers.isAddress(policyAddress)) {
        return policyAddress;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function ensureCoverageReserve(
  providerContract: Awaited<ReturnType<typeof ethers.getContractAt>>,
  ownerSigner: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  requiredCoverageWei: bigint,
): Promise<void> {
  const currentReserveWei = await providerContract.coverageReserveWei();

  if (currentReserveWei >= requiredCoverageWei) {
    return;
  }

  const missingReserveWei = requiredCoverageWei - currentReserveWei;
  const fundingTx = await providerContract.connect(ownerSigner).fundCoverageReserve({
    value: missingReserveWei,
  });
  await fundingTx.wait();

  console.log(`Coverage reserve funded with ${ethers.formatEther(missingReserveWei)} ETH.`);
}

async function getUnsettledCoverageCommitmentWei(
  providerContract: Awaited<ReturnType<typeof ethers.getContractAt>>,
): Promise<bigint> {
  const totalPolicies = await providerContract.getAllPoliciesCount();
  let unsettledCoverageCommitmentWei = 0n;

  for (let index = 0n; index < totalPolicies; index += 1n) {
    const policyAddress = await providerContract.getPolicyAt(index);
    const [coverageWei, , settled] = await providerContract.getPolicyFinancials(policyAddress);

    if (!settled) {
      unsettledCoverageCommitmentWei += coverageWei;
    }
  }

  return unsettledCoverageCommitmentWei;
}

async function ensureMockPolicyRegistryParity(
  providerContract: Awaited<ReturnType<typeof ethers.getContractAt>>,
  ownerSigner: Awaited<ReturnType<typeof ethers.getSigners>>[number],
): Promise<void> {
  const providerAddress = await providerContract.getAddress();
  const oracleAddress = await providerContract.weatherOracle();

  if (!(await hasBytecode(oracleAddress))) {
    throw new Error(
      `Provider weather oracle ${oracleAddress} has no bytecode on network '${network.name}'.`,
    );
  }

  const oracleAsMock = await ethers.getContractAt("MockWeatherOracle", oracleAddress);

  let currentRegistry: string;
  try {
    currentRegistry = await oracleAsMock.policyRegistry();
  } catch {
    console.log(
      `Oracle ${oracleAddress} does not expose MockWeatherOracle policyRegistry(); skipping registry parity sync.`,
    );
    return;
  }

  if (currentRegistry.toLowerCase() === providerAddress.toLowerCase()) {
    return;
  }

  try {
    const setRegistryTx = await oracleAsMock
      .connect(ownerSigner)
      .setPolicyRegistry(providerAddress);
    await setRegistryTx.wait();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `Unable to align mock policy registry to provider ${providerAddress}. Ensure oracle ownership is available to the stress signer or use STRESS_FORCE_DEPLOY=true. Root cause: ${reason}`,
    );
  }

  console.log(`MockWeatherOracle policy registry synchronized to provider ${providerAddress}.`);
}

async function main(): Promise<void> {
  if (network.name !== "hardhat" && network.name !== "localhost") {
    throw new Error(
      `Local stress harness supports only 'hardhat' and 'localhost' networks. Received '${network.name}'.`,
    );
  }

  const options = loadHarnessOptions();
  const signers = await ethers.getSigners();

  if (signers.length < options.insuredAccounts + 1) {
    throw new Error(
      `Not enough local signers. Need at least ${options.insuredAccounts + 1}, found ${signers.length}.`,
    );
  }

  const insuredSigners = signers.slice(1, options.insuredAccounts + 1);
  const providerAddress = await resolveProviderAddress(options, signers[0].address);
  const providerContract = await ethers.getContractAt("InsuranceProvider", providerAddress);

  const onChainOwnerAddress = await providerContract.owner();
  const ownerSigner = signers.find(
    (candidateSigner) =>
      candidateSigner.address.toLowerCase() === onChainOwnerAddress.toLowerCase(),
  );

  if (!ownerSigner) {
    throw new Error(`Could not find local signer for provider owner ${onChainOwnerAddress}.`);
  }

  await ensureMockPolicyRegistryParity(providerContract, ownerSigner);

  const minPremiumBps = Number(await providerContract.MIN_PREMIUM_BPS());
  const maxDurationDays = Number(await providerContract.MAX_DURATION_DAYS());

  if (options.premiumBps < minPremiumBps) {
    throw new Error(
      `STRESS_PREMIUM_BPS (${options.premiumBps}) is below provider minimum (${minPremiumBps}).`,
    );
  }

  if (options.durationDays > maxDurationDays) {
    throw new Error(
      `STRESS_DURATION_DAYS (${options.durationDays}) exceeds provider max duration (${maxDurationDays}).`,
    );
  }

  const premiumWei =
    (options.coverageWei * BigInt(options.premiumBps) + BASIS_POINTS_DENOMINATOR - 1n) /
    BASIS_POINTS_DENOMINATOR;

  const trackedDeficitWei = await providerContract.getBalanceDeficit();
  if (trackedDeficitWei > 0n) {
    throw new Error(
      `Provider has a tracked-balance deficit of ${trackedDeficitWei} wei. Resolve deficit before running stress harness.`,
    );
  }

  const totalRequiredCoverageWei = options.coverageWei * BigInt(options.totalPolicies);
  const unsettledCoverageCommitmentWei = await getUnsettledCoverageCommitmentWei(providerContract);
  const reserveTargetWei = totalRequiredCoverageWei + unsettledCoverageCommitmentWei;

  if (unsettledCoverageCommitmentWei > 0n) {
    console.log(
      `Detected ${ethers.formatEther(unsettledCoverageCommitmentWei)} ETH already committed by unsettled policies; reserve target includes this commitment before starting new bursts.`,
    );
  }

  await ensureCoverageReserve(providerContract, ownerSigner, reserveTargetWei);

  const policiesBefore = await providerContract.getAllPoliciesCount();
  const providerAddressLowerCase = (await providerContract.getAddress()).toLowerCase();
  const providerInterface = providerContract.interface;

  let totalGasUsed = 0n;
  let minGasUsed = 0n;
  let maxGasUsed = 0n;
  let hasGasSample = false;

  const observedPolicyAddresses: string[] = [];
  const totalBursts = Math.ceil(options.totalPolicies / options.burstSize);

  console.log("Starting local burst policy creation stress harness...");
  console.log(`- Network: ${network.name}`);
  console.log(`- Provider: ${providerAddressLowerCase}`);
  console.log(`- Policies target: ${options.totalPolicies}`);
  console.log(`- Burst size: ${options.burstSize}`);
  console.log(`- Coverage per policy: ${ethers.formatEther(options.coverageWei)} ETH`);
  console.log(`- Premium per policy: ${ethers.formatEther(premiumWei)} ETH`);
  console.log(`- Rainfall threshold: ${options.rainfallThresholdMm} mm`);
  console.log(`- Duration: ${options.durationDays} days`);

  const startedAt = Date.now();

  for (let burstIndex = 0; burstIndex < totalBursts; burstIndex += 1) {
    const remainingPolicies = options.totalPolicies - burstIndex * options.burstSize;
    const policiesThisBurst = Math.min(options.burstSize, remainingPolicies);
    const burstSigners = insuredSigners.slice(0, policiesThisBurst);

    const burstStartedAt = Date.now();

    const txResponses = await Promise.all(
      burstSigners.map((insuredSigner) =>
        providerContract
          .connect(insuredSigner)
          .createPolicy(options.coverageWei, options.rainfallThresholdMm, options.durationDays, {
            value: premiumWei,
          }),
      ),
    );

    const receipts = await Promise.all(
      txResponses.map(async (txResponse) => {
        const minedReceipt = await txResponse.wait();

        if (!minedReceipt) {
          throw new Error(`Transaction ${txResponse.hash} was not mined.`);
        }

        return minedReceipt;
      }),
    );

    let burstGasUsed = 0n;

    for (const receipt of receipts) {
      const receiptGasUsed = receipt.gasUsed;
      totalGasUsed += receiptGasUsed;
      burstGasUsed += receiptGasUsed;

      if (!hasGasSample) {
        minGasUsed = receiptGasUsed;
        maxGasUsed = receiptGasUsed;
        hasGasSample = true;
      } else {
        if (receiptGasUsed < minGasUsed) {
          minGasUsed = receiptGasUsed;
        }
        if (receiptGasUsed > maxGasUsed) {
          maxGasUsed = receiptGasUsed;
        }
      }

      const createdPolicyAddress = extractPolicyAddressFromReceipt(
        providerAddressLowerCase,
        providerInterface,
        receipt,
      );
      if (createdPolicyAddress) {
        observedPolicyAddresses.push(createdPolicyAddress);
      }
    }

    const burstDurationMs = Date.now() - burstStartedAt;
    console.log(
      `Burst ${burstIndex + 1}/${totalBursts}: created ${policiesThisBurst} policies in ${burstDurationMs}ms (gas: ${burstGasUsed.toString()}).`,
    );
  }

  const totalDurationMs = Date.now() - startedAt;
  const policiesAfter = await providerContract.getAllPoliciesCount();
  const expectedDelta = BigInt(options.totalPolicies);
  const observedDelta = policiesAfter - policiesBefore;

  if (observedDelta !== expectedDelta) {
    throw new Error(
      `Policy count mismatch after stress run. Expected +${expectedDelta.toString()}, observed +${observedDelta.toString()}.`,
    );
  }

  const averageGasUsed = expectedDelta > 0n ? totalGasUsed / expectedDelta : 0n;
  const throughputPerSecond =
    totalDurationMs > 0 ? ((options.totalPolicies * 1000) / totalDurationMs).toFixed(2) : "n/a";

  console.log("Stress harness summary:");
  console.log(`- Policies created: ${options.totalPolicies}`);
  console.log(`- Total runtime: ${totalDurationMs} ms`);
  console.log(`- Throughput: ${throughputPerSecond} policies/sec`);
  console.log(`- Gas used total: ${totalGasUsed.toString()}`);
  console.log(`- Gas used avg: ${averageGasUsed.toString()}`);
  console.log(`- Gas used min: ${minGasUsed.toString()}`);
  console.log(`- Gas used max: ${maxGasUsed.toString()}`);

  if (observedPolicyAddresses.length > 0) {
    const samplePolicyAddresses = observedPolicyAddresses.slice(0, 5).join(", ");
    console.log(`- Sample policy addresses: ${samplePolicyAddresses}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
