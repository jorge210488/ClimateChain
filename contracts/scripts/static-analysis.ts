import { existsSync, promises as fs, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface StaticPattern {
  name: string;
  regex: RegExp;
  message: string;
}

interface Finding {
  filePath: string;
  line: number;
  name: string;
  message: string;
  snippet: string;
}

interface SanitizedLineResult {
  sanitizedLine: string;
  endsInBlockComment: boolean;
}

interface SlitherCommand {
  command: string;
  availabilityArgs: string[];
  runArgs: string[];
  label: string;
}

const contractsDir = path.resolve(__dirname, "..", "contracts");
const hardhatBuildInfoDir = path.resolve(__dirname, "..", "artifacts", "build-info");
const slitherExcludedDetectors = [
  "arbitrary-send-eth",
  "incorrect-equality",
  "reentrancy-no-eth",
  "reentrancy-benign",
  "reentrancy-events",
].join(",");

const patterns: StaticPattern[] = [
  {
    name: "tx-origin",
    regex: /\btx\.origin\b/,
    message: "Avoid tx.origin for authorization checks.",
  },
  {
    name: "delegatecall",
    regex: /\bdelegatecall\s*\(/,
    message: "delegatecall introduces high-risk execution context coupling.",
  },
  {
    name: "selfdestruct",
    regex: /\bselfdestruct\s*\(/,
    message: "selfdestruct is deprecated and can break system assumptions.",
  },
  {
    name: "callcode",
    regex: /\bcallcode\s*\(/,
    message: "callcode is deprecated and unsafe; avoid using it.",
  },
  {
    name: "signature-string-encoding",
    regex: /\babi\.encodeWithSignature\s*\(/,
    message: "Prefer typed abi.encodeCall instead of string-based signatures.",
  },
];

async function collectSolidityFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        return collectSolidityFiles(fullPath);
      }

      if (entry.isFile() && entry.name.endsWith(".sol")) {
        return [fullPath];
      }

      return [];
    }),
  );

  return nested.flat();
}

function scanFile(filePath: string, content: string): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split(/\r?\n/);
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const { sanitizedLine, endsInBlockComment } = sanitizeLineForScan(line, inBlockComment);
    inBlockComment = endsInBlockComment;

    if (sanitizedLine.trim().length === 0) {
      continue;
    }

    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;

      if (pattern.regex.test(sanitizedLine)) {
        findings.push({
          filePath,
          line: i + 1,
          name: pattern.name,
          message: pattern.message,
          snippet: sanitizedLine.trim(),
        });
      }
    }
  }

  return findings;
}

function sanitizeLineForScan(line: string, startsInBlockComment: boolean): SanitizedLineResult {
  let index = 0;
  let inBlockComment = startsInBlockComment;
  let inString: '"' | "'" | null = null;
  let escaped = false;
  let sanitizedLine = "";

  while (index < line.length) {
    const currentChar = line[index];
    const nextChar = line[index + 1] ?? "";

    if (inBlockComment) {
      if (currentChar === "*" && nextChar === "/") {
        inBlockComment = false;
        index += 2;
        continue;
      }

      index += 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        index += 1;
        continue;
      }

      if (currentChar === "\\") {
        escaped = true;
        index += 1;
        continue;
      }

      if (currentChar === inString) {
        inString = null;
      }

      index += 1;
      continue;
    }

    if (currentChar === "/" && nextChar === "/") {
      return { sanitizedLine, endsInBlockComment: false };
    }

    if (currentChar === "/" && nextChar === "*") {
      inBlockComment = true;
      index += 2;
      continue;
    }

    if (currentChar === '"' || currentChar === "'") {
      inString = currentChar;
      index += 1;
      continue;
    }

    sanitizedLine += currentChar;
    index += 1;
  }

  return { sanitizedLine, endsInBlockComment: inBlockComment };
}

function getWindowsPythonExecutables(): string[] {
  if (process.platform !== "win32") {
    return [];
  }

  const localAppData = process.env.LOCALAPPDATA;

  if (!localAppData) {
    return [];
  }

  const pythonRoot = path.join(localAppData, "Programs", "Python");

  try {
    const entries = readdirSync(pythonRoot, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(pythonRoot, entry.name, "python.exe"))
      .filter((candidatePath) => existsSync(candidatePath))
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }
}

function getSlitherCandidates(): SlitherCommand[] {
  const candidates: SlitherCommand[] = [
    {
      command: "slither",
      availabilityArgs: ["--version"],
      runArgs: ["."],
      label: "slither binary",
    },
    {
      command: "python",
      availabilityArgs: ["-m", "slither", "--version"],
      runArgs: ["-m", "slither", "."],
      label: "python -m slither",
    },
    {
      command: "python3",
      availabilityArgs: ["-m", "slither", "--version"],
      runArgs: ["-m", "slither", "."],
      label: "python3 -m slither",
    },
    {
      command: "py",
      availabilityArgs: ["-m", "slither", "--version"],
      runArgs: ["-m", "slither", "."],
      label: "py -m slither",
    },
  ];

  for (const pythonExecutable of getWindowsPythonExecutables()) {
    const pythonDir = path.dirname(pythonExecutable);
    const slitherExecutable = path.join(pythonDir, "Scripts", "slither.exe");

    if (existsSync(slitherExecutable)) {
      candidates.push({
        command: slitherExecutable,
        availabilityArgs: ["--version"],
        runArgs: ["."],
        label: slitherExecutable,
      });
    }

    candidates.push({
      command: pythonExecutable,
      availabilityArgs: ["-m", "slither", "--version"],
      runArgs: ["-m", "slither", "."],
      label: `${pythonExecutable} -m slither`,
    });
  }

  return candidates;
}

function resolveSlitherCommand(projectRoot: string): SlitherCommand | null {
  for (const candidate of getSlitherCandidates()) {
    const availability = spawnSync(candidate.command, candidate.availabilityArgs, {
      cwd: projectRoot,
      stdio: "ignore",
    });

    if (!availability.error && availability.status === 0) {
      return candidate;
    }
  }

  return null;
}

function hasHardhatBuildInfo(): boolean {
  try {
    const entries = readdirSync(hardhatBuildInfoDir, { withFileTypes: true });

    return entries.some((entry) => entry.isFile() && entry.name.endsWith(".json"));
  } catch {
    return false;
  }
}

function ensureHardhatBuildInfo(projectRoot: string): void {
  if (hasHardhatBuildInfo()) {
    return;
  }

  console.log("Hardhat build-info not found. Compiling once before running Slither...");
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const compileRun = spawnSync(npxCommand, ["hardhat", "compile"], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (compileRun.status !== 0) {
    const statusLabel = compileRun.status === null ? "null" : String(compileRun.status);
    const signalLabel = compileRun.signal ?? "none";

    throw new Error(
      `Hardhat compile failed while preparing Slither input (status: ${statusLabel}, signal: ${signalLabel}).`,
    );
  }
}

function runSlitherIfAvailable(projectRoot: string): boolean {
  const slitherCommand = resolveSlitherCommand(projectRoot);

  if (!slitherCommand) {
    return false;
  }

  ensureHardhatBuildInfo(projectRoot);

  const slitherArgs = [
    ...slitherCommand.runArgs,
    "--hardhat-ignore-compile",
    "--exclude-dependencies",
    "--exclude-low",
    "--exclude-informational",
    "--exclude-optimization",
    "--exclude",
    slitherExcludedDetectors,
  ];

  console.log(
    `Slither detected via ${slitherCommand.label}. Running Stage-04 static analysis profile...`,
  );
  const slitherRun = spawnSync(slitherCommand.command, slitherArgs, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (slitherRun.status !== 0) {
    const statusLabel = slitherRun.status === null ? "null" : String(slitherRun.status);
    const signalLabel = slitherRun.signal ?? "none";

    throw new Error(
      `Slither exited with status ${statusLabel} (signal: ${signalLabel}). This may indicate findings or an execution/configuration error; inspect the output above for root cause.`,
    );
  }

  console.log("Slither completed without findings.");
  return true;
}

async function runFallbackStaticScan(): Promise<void> {
  const files = await collectSolidityFiles(contractsDir);
  const allFindings: Finding[] = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    allFindings.push(...scanFile(filePath, content));
  }

  if (allFindings.length === 0) {
    console.log("Fallback static scan completed with no findings.");
    return;
  }

  console.error("Fallback static scan found potential issues:");
  for (const finding of allFindings) {
    const relativePath = path.relative(path.resolve(__dirname, ".."), finding.filePath);
    console.error(`- ${relativePath}:${finding.line} [${finding.name}] ${finding.message}`);
    console.error(`  ${finding.snippet}`);
  }

  throw new Error(`Fallback static scan found ${allFindings.length} issue(s).`);
}

async function main(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..");

  if (runSlitherIfAvailable(projectRoot)) {
    return;
  }

  console.log("Slither not found. Running fallback static scan patterns.");
  await runFallbackStaticScan();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
