import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";

/**
 * Matches any surrogate code point that stands alone.
 *
 * With the `u` flag a surrogate pair is one astral code point and does not
 * match, so this fires only on halves that were never paired.
 */
const LONE_SURROGATE_REGEX = /\p{Surrogate}/u;

/**
 * Validates that the decorated string is text UTF-8 can represent.
 *
 * JSON permits `"\ud800"` — an unpaired surrogate — and JavaScript carries it
 * in a string quite happily. UTF-8 cannot encode it, so the failure surfaced
 * later and somewhere unhelpful: `Buffer.byteLength` silently counted it as a
 * replacement character, and the region code encoder threw when it finally had
 * to produce bytes. A caller saw a server error for what was a malformed
 * request.
 *
 * Rejecting it at the boundary keeps that a 400, and keeps the byte budget
 * measuring the bytes that will actually be encoded.
 */
export function IsWellFormedText(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isWellFormedText",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== "string") {
            return true; // Reported by the type validator.
          }
          return !LONE_SURROGATE_REGEX.test(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return (
            `${args.property} must be well-formed UTF-8 text; it contains a ` +
            `character that cannot be encoded, such as an unpaired surrogate`
          );
        },
      },
    });
  };
}
