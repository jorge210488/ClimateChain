import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";

import { isEvmAddress } from "../utils/evm-address.util";

/**
 * Validates that a value is a 0x-prefixed 20-byte EVM address.
 *
 * Shares its predicate with {@link isEvmAddress} so DTOs, route pipes, and the
 * contract registry all agree on what a valid address is, instead of each
 * carrying its own copy of the pattern.
 *
 * Pair with `@Transform(normalizeEvmAddress)` on fields used for comparison:
 * validation alone accepts any capitalization, which would then fail to match
 * on-chain values spelled differently.
 */
export function IsEvmAddress(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isEvmAddress",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isEvmAddress(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a valid 0x-prefixed 20-byte EVM address`;
        },
      },
    });
  };
}
