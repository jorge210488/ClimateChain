import { ChainPolicy } from "./policy-chain.service";
import { PolicySettlementType } from "./policy-settlement.enum";
import { PolicyStatus } from "./policy-status.enum";
import { toPolicyResponse } from "./policy.mapper";

function buildChainPolicy(overrides: Partial<ChainPolicy> = {}): ChainPolicy {
  return {
    address: "0xcafac3dd18ac6c6e92c921884f9e4176737c052c",
    insured: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    oracle: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    status: PolicyStatus.Active,
    coverageWei: "1000000000000000000",
    premiumWei: "50000000000000000",
    rainfallThresholdMm: "50",
    latestRainfallMm: "0",
    pendingPayoutWei: "0",
    conditionMet: false,
    paidOut: false,
    regionCode:
      "0x56616c656e636961000000000000000000000000000000000000000000000000",
    region: "Valencia",
    startTimestamp: 1785009789,
    endTimestamp: 1787601789,
    lastOracleUpdateTimestamp: 0,
    settlementType: PolicySettlementType.None,
    settledAt: undefined,
    ...overrides,
  };
}

describe("toPolicyResponse", () => {
  it("projects every field of the chain view", () => {
    const response = toPolicyResponse(buildChainPolicy());

    expect(response).toEqual({
      address: "0xcafac3dd18ac6c6e92c921884f9e4176737c052c",
      insured: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      oracle: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      status: PolicyStatus.Active,
      coverageWei: "1000000000000000000",
      premiumWei: "50000000000000000",
      rainfallThresholdMm: "50",
      latestRainfallMm: "0",
      pendingPayoutWei: "0",
      conditionMet: false,
      paidOut: false,
      regionCode:
        "0x56616c656e636961000000000000000000000000000000000000000000000000",
      region: "Valencia",
      startTimestamp: 1785009789,
      endTimestamp: 1787601789,
      lastOracleUpdateTimestamp: 0,
      settlementType: PolicySettlementType.None,
      settledAt: undefined,
    });
  });

  it("keeps wei amounts as strings", () => {
    // uint256 exceeds Number.MAX_SAFE_INTEGER; serializing as a number would
    // silently corrupt large balances.
    const huge = (2n ** 200n).toString();
    const response = toPolicyResponse(
      buildChainPolicy({ coverageWei: huge, pendingPayoutWei: huge }),
    );

    expect(response.coverageWei).toBe(huge);
    expect(response.pendingPayoutWei).toBe(huge);
    expect(typeof response.coverageWei).toBe("string");
  });

  it("carries a claimable payout through", () => {
    // The field that tells an insured party money is waiting for them.
    const response = toPolicyResponse(
      buildChainPolicy({
        status: PolicyStatus.PaidOut,
        paidOut: true,
        pendingPayoutWei: "1000000000000000000",
        settlementType: PolicySettlementType.Payout,
        settledAt: 1785099999,
      }),
    );

    expect(response.pendingPayoutWei).toBe("1000000000000000000");
    expect(response.settlementType).toBe(PolicySettlementType.Payout);
    expect(response.settledAt).toBe(1785099999);
  });

  it("omits region when the on-chain code is not decodable", () => {
    const response = toPolicyResponse(buildChainPolicy({ region: undefined }));

    expect(response.region).toBeUndefined();
    // The raw code is still exposed, so nothing is hidden from the caller.
    expect(response.regionCode).toBeDefined();
  });
});
