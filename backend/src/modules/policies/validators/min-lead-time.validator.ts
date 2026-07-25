import { registerDecorator, ValidationOptions } from "class-validator";

import { POLICY_DOMAIN } from "../policy.constants";

/** Total lead time required at request time, in seconds. */
export const REQUIRED_START_LEAD_TIME_SECONDS =
  POLICY_DOMAIN.minPolicyStartLeadTimeSeconds +
  POLICY_DOMAIN.startLeadTimeSafetyMarginSeconds;

/**
 * Validates that the decorated Unix timestamp (seconds) is far enough in the
 * future to still satisfy the on-chain `MIN_POLICY_START_LEAD_TIME_SECONDS`
 * check when the transaction is mined.
 *
 * The contract evaluates the lead time against `block.timestamp`, which is
 * strictly later than the wall-clock time seen here. Validating against the
 * bare on-chain minimum would therefore accept requests that are guaranteed to
 * revert, so a safety margin is added. Applied only when the optional field is
 * present.
 */
export function IsAfterMinLeadTime(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isAfterMinLeadTime",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== "number") {
            return true;
          }
          const nowSeconds = Math.floor(Date.now() / 1000);
          return value >= nowSeconds + REQUIRED_START_LEAD_TIME_SECONDS;
        },
        defaultMessage(): string {
          return (
            `requestedStartTimestamp must be at least ` +
            `${REQUIRED_START_LEAD_TIME_SECONDS} seconds in the future ` +
            `(${POLICY_DOMAIN.minPolicyStartLeadTimeSeconds}s on-chain minimum ` +
            `plus a ${POLICY_DOMAIN.startLeadTimeSafetyMarginSeconds}s margin ` +
            `for transaction inclusion)`
          );
        },
      },
    });
  };
}
