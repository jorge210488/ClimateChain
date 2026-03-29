import { promises as fs } from "node:fs";
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

const contractsDir = path.resolve(__dirname, "..", "contracts");

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

function runSlitherIfAvailable(projectRoot: string): boolean {
  const availability = spawnSync("slither", ["--version"], {
    cwd: projectRoot,
    stdio: "ignore",
  });

  if (availability.error || availability.status !== 0) {
    return false;
  }

  console.log("Slither detected. Running slither static analysis...");
  const slitherRun = spawnSync("slither", ["."], {
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
