import { promises as fs } from "node:fs";
import path from "node:path";

interface HardhatArtifact {
  contractName: string;
  sourceName: string;
  abi: unknown[];
}

interface AbiIndexEntry {
  contractName: string;
  sourceName: string;
  file: string;
}

const CONTRACTS_TO_EXPORT = new Set([
  "InsuranceProvider",
  "InsurancePolicy",
  "IInsuranceProviderRegistry",
  "IInsurancePolicy",
  "IWeatherOracleAdapter",
  "MockWeatherOracle",
]);
const artifactsRoot = path.resolve(__dirname, "..", "artifacts", "contracts");
const abiOutputDir = path.resolve(__dirname, "..", "..", "shared", "abi");

async function collectArtifactFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = await Promise.all(
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

  return files.flat();
}

async function readArtifact(filePath: string): Promise<HardhatArtifact | null> {
  const artifactRaw = await fs.readFile(filePath, "utf8");
  const artifact = JSON.parse(artifactRaw) as Partial<HardhatArtifact>;

  if (!artifact.contractName || !Array.isArray(artifact.abi) || !artifact.sourceName) {
    return null;
  }

  if (!CONTRACTS_TO_EXPORT.has(artifact.contractName)) {
    return null;
  }

  return {
    contractName: artifact.contractName,
    sourceName: artifact.sourceName,
    abi: artifact.abi,
  };
}

async function exportAbis(): Promise<void> {
  await fs.mkdir(abiOutputDir, { recursive: true });

  let artifactFiles: string[];
  try {
    artifactFiles = await collectArtifactFiles(artifactsRoot);
  } catch {
    throw new Error(
      "Artifacts directory was not found. Run 'npm run compile' before exporting ABIs.",
    );
  }

  const entries: AbiIndexEntry[] = [];
  const generatedAt = new Date().toISOString();

  for (const artifactFile of artifactFiles) {
    const artifact = await readArtifact(artifactFile);

    if (!artifact) {
      continue;
    }

    const outputFileName = `${artifact.contractName}.json`;
    const outputPath = path.join(abiOutputDir, outputFileName);

    const exportPayload = {
      contractName: artifact.contractName,
      sourceName: artifact.sourceName,
      generatedAt,
      abi: artifact.abi,
    };

    await fs.writeFile(outputPath, `${JSON.stringify(exportPayload, null, 2)}\n`, "utf8");

    entries.push({
      contractName: artifact.contractName,
      sourceName: artifact.sourceName,
      file: outputFileName,
    });
  }

  const exportedContractNames = new Set(entries.map((entry) => entry.contractName));
  const missingContracts = [...CONTRACTS_TO_EXPORT]
    .filter((contractName) => !exportedContractNames.has(contractName))
    .sort((left, right) => left.localeCompare(right));

  if (missingContracts.length > 0) {
    throw new Error(
      `Missing required ABI artifacts for: ${missingContracts.join(
        ", ",
      )}. Run 'npm run clean && npm run compile' and verify CONTRACTS_TO_EXPORT.`,
    );
  }

  entries.sort((left, right) => left.contractName.localeCompare(right.contractName));

  const indexPath = path.join(abiOutputDir, "index.json");
  const indexPayload = {
    generatedAt,
    contracts: entries,
  };

  await fs.writeFile(indexPath, `${JSON.stringify(indexPayload, null, 2)}\n`, "utf8");

  const exportedNames = entries.map((entry) => entry.contractName).join(", ");
  console.log(`Exported ABIs to ${abiOutputDir}`);
  console.log(`Contracts exported: ${exportedNames}`);
}

exportAbis().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
