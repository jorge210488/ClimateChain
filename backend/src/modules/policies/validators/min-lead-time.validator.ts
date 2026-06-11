import { registerDecorator, ValidationOptions } from "class-validator";

import { POLICY_DOMAIN } from "../policy.constants";

/**
 * Validates that the decorated Unix timestamp (seconds) is at least
 * `MIN_POLICY_START_LEAD_TIME_SECONDS` in the future, mirroring the on-chain
 * minimum start lead time. Applied only when the optional field is present.
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
          return (
            value >= nowSeconds + POLICY_DOMAIN.minPolicyStartLeadTimeSeconds
          );
        },
        defaultMessage(): string {
          return (
            `requestedStartTimestamp must be at least ` +
            `${POLICY_DOMAIN.minPolicyStartLeadTimeSeconds} seconds in the future`
          );
        },
      },
    });
  };
}
