import { promises as fs } from "node:fs";
import path from "node:path";

interface HardhatArtifact {
  contractName: string;
  deployedBytecode: string;
}

interface ContractSizeEntry {
  contractName: string;
  deployedBytecodeBytes: number;
}

interface ContractSizeBaseline {
  generatedAt: string;
  contracts: ContractSizeEntry[];
}

const targetContracts = ["InsuranceProvider", "InsurancePolicy", "MockWeatherOracle"];
const artifactsRoot = path.resolve(__dirname, "..", "artifacts", "contracts");
const baselinePath = path.resolve(__dirname, "..", "deployments", "contract-size-baseline.json");

const maxEip170Bytes = 24_576;

function parseGrowthToleranceBytes(rawTolerance: string | undefined): number {
  const parsedTolerance = Number(rawTolerance ?? "512");

  if (
    !Number.isFinite(parsedTolerance) ||
    !Number.isInteger(parsedTolerance) ||
    parsedTolerance < 0
  ) {
    throw new Error(
      "SIZE_GROWTH_TOLERANCE_BYTES must be a non-negative integer (for example: 0, 128, 512).",
    );
  }

  return parsedTolerance;
}

const maxGrowthToleranceBytes = parseGrowthToleranceBytes(process.env.SIZE_GROWTH_TOLERANCE_BYTES);

async function collectArtifactFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        return collectArtifactFiles(fullPath);
      }

      if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) {
        return [fullPath];
      }

      return [];
    }),
  );

  return nestedFiles.flat();
}

function deployedBytecodeSizeInBytes(deployedBytecode: string): number {
  if (!deployedBytecode || deployedBytecode === "0x") {
    return 0;
  }

  const normalized = deployedBytecode.startsWith("0x")
    ? deployedBytecode.slice(2)
    : deployedBytecode;

  return normalized.length / 2;
}

async function getCurrentSizes(): Promise<ContractSizeEntry[]> {
  let artifactFiles: string[];
  try {
    artifactFiles = await collectArtifactFiles(artifactsRoot);
  } catch {
    throw new Error(
      "Artifacts directory was not found. Run 'npm run compile' before size reporting.",
    );
  }

  const selected = new Map<string, ContractSizeEntry>();

  for (const artifactFile of artifactFiles) {
    const raw = await fs.readFile(artifactFile, "utf8");
    const artifact = JSON.parse(raw) as Partial<HardhatArtifact>;

    if (!artifact.contractName || !targetContracts.includes(artifact.contractName)) {
      continue;
    }

    const deployedBytecode =
      typeof artifact.deployedBytecode === "string" ? artifact.deployedBytecode : "0x";

    selected.set(artifact.contractName, {
      contractName: artifact.contractName,
      deployedBytecodeBytes: deployedBytecodeSizeInBytes(deployedBytecode),
    });
  }

  const missing = targetContracts.filter((contractName) => !selected.has(contractName));
  if (missing.length > 0) {
    throw new Error(`Could not find artifacts for: ${missing.join(", ")}`);
  }

  return [...selected.values()].sort((a, b) => a.contractName.localeCompare(b.contractName));
}

function printSizeReport(current: ContractSizeEntry[], baseline: ContractSizeEntry[] | null): void {
  console.log("Contract size report (deployed bytecode bytes):");

  for (const entry of current) {
    const baselineEntry =
      baseline?.find((item) => item.contractName === entry.contractName) ?? null;
    const delta = baselineEntry
      ? entry.deployedBytecodeBytes - baselineEntry.deployedBytecodeBytes
      : 0;
    const deltaLabel = baselineEntry ? ` (delta: ${delta >= 0 ? "+" : ""}${delta})` : "";

    console.log(`- ${entry.contractName}: ${entry.deployedBytecodeBytes}${deltaLabel}`);
  }
}

async function readBaseline(): Promise<ContractSizeBaseline | null> {
  try {
    const raw = await fs.readFile(baselinePath, "utf8");
    return JSON.parse(raw) as ContractSizeBaseline;
  } catch {
    return null;
  }
}

async function writeBaseline(entries: ContractSizeEntry[]): Promise<void> {
  const baselinePayload: ContractSizeBaseline = {
    generatedAt: new Date().toISOString(),
    contracts: entries,
  };

  await fs.mkdir(path.dirname(baselinePath), { recursive: true });
  await fs.writeFile(baselinePath, `${JSON.stringify(baselinePayload, null, 2)}\n`, "utf8");
}

function assertEip170Limit(entries: ContractSizeEntry[]): void {
  for (const entry of entries) {
    if (entry.deployedBytecodeBytes > maxEip170Bytes) {
      throw new Error(
        `${entry.contractName} exceeds EIP-170 size limit (${entry.deployedBytecodeBytes} > ${maxEip170Bytes}).`,
      );
    }
  }
}

function assertGrowthWithinTolerance(
  current: ContractSizeEntry[],
  baseline: ContractSizeEntry[],
): void {
  for (const entry of current) {
    const baselineEntry = baseline.find((item) => item.contractName === entry.contractName);
    if (!baselineEntry) {
      continue;
    }

    const growth = entry.deployedBytecodeBytes - baselineEntry.deployedBytecodeBytes;
    if (growth > maxGrowthToleranceBytes) {
      throw new Error(
        `${entry.contractName} grew by ${growth} bytes, above tolerance of ${maxGrowthToleranceBytes} bytes.`,
      );
    }
  }
}

function assertBaselineHasTrackedContracts(
  current: ContractSizeEntry[],
  baseline: ContractSizeEntry[],
): void {
  const missingBaselineEntries = current
    .filter(
      (entry) =>
        !baseline.some((baselineEntry) => baselineEntry.contractName === entry.contractName),
    )
    .map((entry) => entry.contractName);

  if (missingBaselineEntries.length > 0) {
    throw new Error(
      `Baseline is missing tracked contracts: ${missingBaselineEntries.join(
        ", ",
      )}. Run 'npm run size:baseline:update' after reviewing expected changes.`,
    );
  }
}

async function main(): Promise<void> {
  const current = await getCurrentSizes();
  const baselineFile = await readBaseline();
  const baselineEntries = baselineFile?.contracts ?? null;

  assertEip170Limit(current);

  if (!baselineEntries || process.env.UPDATE_SIZE_BASELINE === "true") {
    await writeBaseline(current);
    printSizeReport(current, null);
    console.log(`Size baseline written to ${baselinePath}.`);
    return;
  }

  assertBaselineHasTrackedContracts(current, baselineEntries);
  assertGrowthWithinTolerance(current, baselineEntries);
  printSizeReport(current, baselineEntries);
  console.log(
    `All tracked contracts are within ${maxGrowthToleranceBytes} bytes growth tolerance from baseline.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
