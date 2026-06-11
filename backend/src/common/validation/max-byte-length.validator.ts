import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";

/**
 * Validates that a string's UTF-8 byte length does not exceed `max`.
 *
 * Unlike `@MaxLength` (which counts UTF-16 code units), this matches what fits
 * into a fixed-size on-chain field such as `bytes32`, so multibyte strings are
 * rejected before they would fail encoding.
 */
export function MaxByteLength(
  max: number,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "maxByteLength",
      target: object.constructor,
      propertyName,
      constraints: [max],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== "string") {
            return true;
          }
          const [maxBytes] = args.constraints as [number];
          return Buffer.byteLength(value, "utf8") <= maxBytes;
        },
        defaultMessage(args: ValidationArguments): string {
          const [maxBytes] = args.constraints as [number];
          return `${args.property} must be at most ${maxBytes} UTF-8 bytes`;
        },
      },
    });
  };
}
