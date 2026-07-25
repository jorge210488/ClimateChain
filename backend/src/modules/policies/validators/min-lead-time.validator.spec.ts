import { validateSync } from "class-validator";

import { POLICY_DOMAIN } from "../policy.constants";
import {
  IsAfterMinLeadTime,
  REQUIRED_START_LEAD_TIME_SECONDS,
} from "./min-lead-time.validator";

class Subject {
  @IsAfterMinLeadTime()
  requestedStartTimestamp?: number;
}

function violations(timestamp?: number): string[] {
  const subject = new Subject();
  subject.requestedStartTimestamp = timestamp;
  return validateSync(subject).map((error) => error.property);
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe("IsAfterMinLeadTime", () => {
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
