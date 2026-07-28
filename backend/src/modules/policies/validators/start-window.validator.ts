import { registerDecorator, ValidationOptions } from "class-validator";

import { POLICY_DOMAIN } from "../policy.constants";

/** Total lead time required at request time, in seconds. */
export const REQUIRED_START_LEAD_TIME_SECONDS =
  POLICY_DOMAIN.minPolicyStartLeadTimeSeconds +
  POLICY_DOMAIN.startLeadTimeSafetyMarginSeconds;

/** Furthest ahead a start may be requested, in seconds. */
export const MAX_START_LEAD_TIME_SECONDS =
  POLICY_DOMAIN.maxPolicyStartLeadTimeSeconds;

/**
 * Validates that the decorated Unix timestamp (seconds) falls inside the window
 * the contract will accept.
 *
 * **Lower bound.** The contract evaluates the lead time against
 * `block.timestamp`, which is strictly later than the wall-clock time seen here.
 * Validating against the bare on-chain minimum would accept requests that are
 * guaranteed to revert, so a safety margin is added.
 *
 * **Upper bound.** Coverage is reserved at creation and released only at
 * settlement, so a start far enough ahead immobilizes the reserve for that whole
 * span. The contract caps it; rejecting here turns what would be a revert into
 * a plain 400 that names the limit.
 *
 * Applied only when the optional field is present.
 */
export function IsWithinStartWindow(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isWithinStartWindow",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== "number") {
            return true;
          }
          const nowSeconds = Math.floor(Date.now() / 1000);
          return (
            value >= nowSeconds + REQUIRED_START_LEAD_TIME_SECONDS &&
            value <= nowSeconds + MAX_START_LEAD_TIME_SECONDS
          );
        },
        defaultMessage(): string {
          return (
            `requestedStartTimestamp must be between ` +
            `${REQUIRED_START_LEAD_TIME_SECONDS} seconds and ` +
            `${MAX_START_LEAD_TIME_SECONDS} seconds in the future ` +
            `(${POLICY_DOMAIN.minPolicyStartLeadTimeSeconds}s on-chain minimum ` +
            `plus a ${POLICY_DOMAIN.startLeadTimeSafetyMarginSeconds}s margin ` +
            `for transaction inclusion, and an on-chain cap of ` +
            `${POLICY_DOMAIN.maxPolicyStartLeadTimeSeconds}s so a policy cannot ` +
            `lock coverage indefinitely)`
          );
        },
      },
    });
  };
}
