import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";

/**
 * Validates that a value is an integer JavaScript represents exactly.
 *
 * `@IsInt()` is not enough on its own. It accepts any value `Number.isInteger`
 * accepts, and that includes integers beyond 2^53 which have already lost
 * precision: `Number("9007199254740993")` silently becomes `9007199254740992`,
 * passes `@IsInt()`, and is then rejected by ABI encoding as an overflow —
 * surfacing as a generic server error for what is really a bad input.
 *
 * Rejecting it here keeps the boundary honest: a number the API cannot carry
 * without corrupting it is a client error, not a server fault.
 */
export function IsSafeInteger(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isSafeInteger",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === "number" && Number.isSafeInteger(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return (
            `${args.property} must be an integer that can be represented ` +
            `exactly (at most ${Number.MAX_SAFE_INTEGER})`
          );
        },
      },
    });
  };
}
