import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { POLICY_DOMAIN } from "./policy.constants";
import { POLICY_STATUS_BY_INDEX } from "./policy-status.enum";

/**
 * Drift detection for the on-chain values mirrored in `POLICY_DOMAIN`.
 *
 * These constants drive DTO validation, so a silent change on the contract side
 * would make the API accept requests that revert (or reject requests that would
 * succeed). Stage 04 already gates ABI drift, but an ABI carries no constant
 * *values* and no enum ordering, so neither is covered by that check.
 *
 * This reads the contract sources directly. It is a source-level guard, not a
 * substitute for the on-chain verification Stage 06 should add once a live
 * client can call the public getters; it catches drift earlier, in a unit test,
 * without needing a node.
 */
const CONTRACTS_DIR = resolve(process.cwd(), "..", "contracts", "contracts");
const PROVIDER_SOURCE = resolve(CONTRACTS_DIR, "InsuranceProvider.sol");
const POLICY_SOURCE = resolve(CONTRACTS_DIR, "InsurancePolicy.sol");

function readSource(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `Contract source not found at ${path}. This test must run from the ` +
        `backend/ package directory with the contracts workspace present.`,
    );
  }
  return readFileSync(path, "utf-8");
}

/** Extracts the literal value of a `constant` declaration, ignoring separators. */
function readSolidityConstant(source: string, name: string): number {
  const pattern = new RegExp(`constant\\s+${name}\\s*=\\s*([0-9_]+)\\s*;`, "m");
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(
      `Could not find constant "${name}" in the contract source. If it was ` +
        `renamed or removed, POLICY_DOMAIN must be updated to match.`,
    );
  }
  return Number(match[1].replace(/_/g, ""));
}

describe("POLICY_DOMAIN mirrors the on-chain constants", () => {
  const providerSource = readSource(PROVIDER_SOURCE);

  it.each([
    ["MAX_DURATION_DAYS", "maxDurationDays"],
    ["MIN_PREMIUM_BPS", "minPremiumBps"],
    ["BASIS_POINTS_DENOMINATOR", "basisPointsDenominator"],
    ["MIN_POLICY_START_LEAD_TIME_SECONDS", "minPolicyStartLeadTimeSeconds"],
  ] as const)("%s matches POLICY_DOMAIN.%s", (solidityName, domainKey) => {
    expect(readSolidityConstant(providerSource, solidityName)).toBe(
      POLICY_DOMAIN[domainKey],
    );
  });

  it("keeps the region budget within what bytes32 can hold", () => {
    // 32 bytes minus one, matching the length-prefixed encoding used on chain.
    expect(POLICY_DOMAIN.maxRegionCodeLength).toBe(31);
  });

  it("keeps the safety margin positive so it cannot silently disappear", () => {
    // A zero margin would restore the race the margin exists to prevent:
    // validation against wall-clock time vs. the contract's block.timestamp.
    expect(POLICY_DOMAIN.startLeadTimeSafetyMarginSeconds).toBeGreaterThan(0);
  });
});

describe("PolicyStatus mirrors the on-chain enum order", () => {
  it("matches the declaration order in InsurancePolicy.sol", () => {
    const source = readSource(POLICY_SOURCE);
    const enumBody = /enum\s+PolicyStatus\s*\{([^}]*)\}/m.exec(source);
    expect(enumBody).not.toBeNull();

    const declaredOrder = (enumBody as RegExpExecArray)[1]
      .split("\n")
      .map((line) =>
        line
          .replace(/\/\/.*$/, "")
          .trim()
          .replace(/,$/, ""),
      )
      .filter((line) => line.length > 0 && !line.startsWith("///"));

    expect(declaredOrder).toEqual([
      "Created",
      "Active",
      "Triggered",
      "PaidOut",
      "Expired",
    ]);
    expect(POLICY_STATUS_BY_INDEX).toHaveLength(declaredOrder.length);
  });
});
