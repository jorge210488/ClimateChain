import { validateSync } from "class-validator";

import { POLICY_DOMAIN } from "../policy.constants";
import {
  IsWithinStartWindow,
  MAX_START_LEAD_TIME_SECONDS,
  REQUIRED_START_LEAD_TIME_SECONDS,
} from "./start-window.validator";

class Subject {
  @IsWithinStartWindow()
  requestedStartTimestamp?: number;
}

function violations(timestamp?: number): string[] {
  const subject = new Subject();
  subject.requestedStartTimestamp = timestamp;
  return validateSync(subject).map((error) => error.property);
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe("IsWithinStartWindow", () => {
  it("requires a margin above the bare on-chain minimum", () => {
    // The contract would accept this against block.timestamp at mining time,
    // but only if the transaction were mined instantly. Rejecting it here is
    // the point of the margin: the request is otherwise certain to revert.
    const atOnChainMinimum =
      nowSeconds() + POLICY_DOMAIN.minPolicyStartLeadTimeSeconds;

    expect(violations(atOnChainMinimum)).toContain("requestedStartTimestamp");
  });

  it("accepts a start beyond the required lead time", () => {
    expect(
      violations(nowSeconds() + REQUIRED_START_LEAD_TIME_SECONDS + 5),
    ).toEqual([]);
  });

  it("rejects a start inside the lead-time window", () => {
    expect(violations(nowSeconds() + 5)).toContain("requestedStartTimestamp");
  });

  it("rejects a start beyond the on-chain cap", () => {
    // Coverage is reserved at creation, so a start far enough ahead ties up the
    // reserve for that whole span. The contract refuses it; catching it here
    // turns a revert into a 400 that names the limit.
    expect(
      violations(nowSeconds() + MAX_START_LEAD_TIME_SECONDS + 60),
    ).toContain("requestedStartTimestamp");
  });

  it("accepts a start just inside the cap", () => {
    expect(violations(nowSeconds() + MAX_START_LEAD_TIME_SECONDS - 60)).toEqual(
      [],
    );
  });

  it("mirrors the on-chain cap", () => {
    expect(MAX_START_LEAD_TIME_SECONDS).toBe(
      POLICY_DOMAIN.maxPolicyStartLeadTimeSeconds,
    );
  });

  it("ignores an absent value so the field stays optional", () => {
    expect(violations(undefined)).toEqual([]);
  });

  it("derives the requirement from the on-chain minimum plus the margin", () => {
    expect(REQUIRED_START_LEAD_TIME_SECONDS).toBe(
      POLICY_DOMAIN.minPolicyStartLeadTimeSeconds +
        POLICY_DOMAIN.startLeadTimeSafetyMarginSeconds,
    );
  });
});
