import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";

import { parseEthToWei } from "../../../common/utils/eth-amount.util";
import { POLICY_DOMAIN } from "../policy.constants";

/**
 * Validates that the decorated premium (ETH string) is at least the on-chain
 * minimum relative to the coverage field: `coverage * MIN_PREMIUM_BPS / 10000`,
 * rounded up to match the contract's ceil rounding. Inputs with an invalid
 * format are deferred to the format validator.
 */
export function IsAtLeastMinPremium(
  coverageProperty: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isAtLeastMinPremium",
      target: object.constructor,
      propertyName,
      constraints: [coverageProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [coverageProp] = args.constraints as [string];
          const coverage = (args.object as Record<string, unknown>)[
            coverageProp
          ];
          if (typeof value !== "string" || typeof coverage !== "string") {
            return true;
          }

          let premiumWei: bigint;
          let coverageWei: bigint;
          try {
            premiumWei = parseEthToWei(value);
            coverageWei = parseEthToWei(coverage);
          } catch {
            return true; // format errors are reported by @Matches
          }

          const denom = BigInt(POLICY_DOMAIN.basisPointsDenominator);
          const bps = BigInt(POLICY_DOMAIN.minPremiumBps);
          // Ceil division to match the contract's Math.Rounding.Ceil.
          const minPremiumWei = (coverageWei * bps + denom - 1n) / denom;
          return premiumWei >= minPremiumWei;
        },
        defaultMessage(): string {
          return `premiumEth must be at least ${
            POLICY_DOMAIN.minPremiumBps / 100
          }% of coverageEth`;
        },
      },
    });
  };
}
