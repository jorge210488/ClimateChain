import { PolicyStatus, policyStatusFromIndex } from "./policy-status.enum";

describe("policyStatusFromIndex", () => {
  it("maps on-chain enum indices to API statuses", () => {
    expect(policyStatusFromIndex(0)).toBe(PolicyStatus.Created);
    expect(policyStatusFromIndex(1)).toBe(PolicyStatus.Active);
    expect(policyStatusFromIndex(2)).toBe(PolicyStatus.Triggered);
    expect(policyStatusFromIndex(3)).toBe(PolicyStatus.PaidOut);
    expect(policyStatusFromIndex(4)).toBe(PolicyStatus.Expired);
  });

  it("throws on an unknown index", () => {
    expect(() => policyStatusFromIndex(5)).toThrow(
      /Unknown on-chain policy status index/,
    );
  });
});
