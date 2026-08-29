import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";

import { POLICY_DOMAIN } from "../../policies/policy.constants";

/**
 * Validates that the decorated ISO-8601 date is on or after the sibling date
 * referenced by `startProperty`. Malformed inputs are deferred to the format
 * validator (`@IsDateString`) so this only guards the semantic range.
 */
export function IsOnOrAfter(
  startProperty: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isOnOrAfter",
      target: object.constructor,
      propertyName,
      constraints: [startProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [startProp] = args.constraints as [string];
          const start = (args.object as Record<string, unknown>)[startProp];
          if (typeof value !== "string" || typeof start !== "string") {
            return true;
          }
          const startMs = Date.parse(start);
          const endMs = Date.parse(value);
          if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
            return true; // Format errors are reported by the date pattern.
          }
          return endMs >= startMs;
        },
        defaultMessage(args: ValidationArguments): string {
          const [startProp] = args.constraints as [string];
          return `${args.property} must be on or after ${startProp}`;
        },
      },
    });
  };
}

/** Milliseconds in a day, for turning a window into whole days. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Validates that the coverage window fits inside `MAX_DURATION_DAYS`.
 *
 * Endpoints are inclusive, so a window from the first to the last of a month is
 * that many days rather than one fewer — the same arithmetic the ML service
 * uses, and the same the provider enforces when the policy is created.
 *
 * Without this the pricing endpoint accepted windows no policy could ever have.
 * Quoting one produces a premium the caller cannot use, and the mismatch would
 * surface only once Stage 09 forwarded the request to a service that does check.
 */
export function IsWithinMaxCoverageWindow(
  startProperty: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isWithinMaxCoverageWindow",
      target: object.constructor,
      propertyName,
      constraints: [startProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [startProp] = args.constraints as [string];
          const start = (args.object as Record<string, unknown>)[startProp];
          if (typeof value !== "string" || typeof start !== "string") {
            return true;
          }
          const startMs = Date.parse(start);
          const endMs = Date.parse(value);
          if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
            return true; // Reported by the date pattern and the ordering check.
          }
          const days = Math.round((endMs - startMs) / MS_PER_DAY) + 1;
          return days <= POLICY_DOMAIN.maxDurationDays;
        },
        defaultMessage(args: ValidationArguments): string {
          const [startProp] = args.constraints as [string];
          return (
            `the window from ${startProp} to ${args.property} must not exceed ` +
            `${POLICY_DOMAIN.maxDurationDays} days, the maximum policy duration ` +
            `the provider will create`
          );
        },
      },
    });
  };
}

/**
 * Validates that the decorated string names a date that exists.
 *
 * The shape regex cannot: `2026-02-30` matches `YYYY-MM-DD` perfectly and is
 * not a day. Worse than being accepted, it was then *normalised* — `Date.parse`
 * rolls it forward to 2 March, so the window priced and the window requested
 * were different windows. `2026-13-01` parsed to `NaN`, and the range checks
 * pass a `NaN` through on the assumption that some other validator rejects it.
 *
 * Round-tripping is the check: parse as UTC and re-render. A date that survives
 * unchanged is real; one that was rolled forward comes back different.
 */
export function IsRealCalendarDate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isRealCalendarDate",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== "string") {
            return true; // Reported by the type and shape validators.
          }
          const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
          if (!match) {
            return true; // Reported by the shape validator.
          }

          const [, year, month, day] = match;
          const parsed = new Date(
            Date.UTC(Number(year), Number(month) - 1, Number(day)),
          );
          if (Number.isNaN(parsed.getTime())) {
            return false;
          }

          // A rolled-forward date re-renders as a different day.
          return (
            parsed.getUTCFullYear() === Number(year) &&
            parsed.getUTCMonth() === Number(month) - 1 &&
            parsed.getUTCDate() === Number(day)
          );
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a date that exists in the calendar`;
        },
      },
    });
  };
}
