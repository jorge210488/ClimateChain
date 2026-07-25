import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  POLICY_SETTLEMENT_BY_INDEX,
  PolicySettlementType,
  policySettlementFromIndex,
} from "./policy-settlement.enum";

describe("policySettlementFromIndex", () => {
  it.each([
    [0, PolicySettlementType.None],
    [1, PolicySettlementType.Payout],
    [2, PolicySettlementType.Expiry],
  ])("maps on-chain index %i", (index, expected) => {
    expect(policySettlementFromIndex(index)).toBe(expected);
  });

  it.each([-1, 3, 99])("throws on unknown index %i", (index) => {
    expect(() => policySettlementFromIndex(index)).toThrow(/Unknown/);
  });

  it("mirrors the on-chain enum declaration order", () => {
    const source = resolve(
      process.cwd(),
      "..",
      "contracts",
      "contracts",
      "InsuranceProvider.sol",
    );
    expect(existsSync(source)).toBe(true);

    const enumBody = /enum\s+SettlementType\s*\{([^}]*)\}/m.exec(
      readFileSync(source, "utf-8"),
    );
    expect(enumBody).not.toBeNull();

    const declaredOrder = (enumBody as RegExpExecArray)[1]
      .split("\n")
      .map((line) =>
        line
          .replace(/\/\/.*$/, "")
          .trim()
          .replace(/,$/, ""),
      )
      .filter((line) => line.length > 0);

    expect(declaredOrder).toEqual(["None", "Payout", "Expiry"]);
    expect(POLICY_SETTLEMENT_BY_INDEX).toHaveLength(declaredOrder.length);
  });
});
