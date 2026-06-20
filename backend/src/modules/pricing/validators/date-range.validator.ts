import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";

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
            return true; // Format errors are reported by @IsDateString.
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
