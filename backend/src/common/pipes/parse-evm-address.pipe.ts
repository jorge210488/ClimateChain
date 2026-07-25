import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";

import { isEvmAddress, normalizeEvmAddress } from "../utils/evm-address.util";

/**
 * Validates a route/query parameter as an EVM address and returns it in
 * canonical (lowercase) form, so downstream comparisons against on-chain data
 * are not defeated by the caller's capitalization.
 */
@Injectable()
export class ParseEvmAddressPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isEvmAddress(value)) {
      throw new BadRequestException(
        `"${value}" is not a valid 0x-prefixed 20-byte EVM address`,
      );
    }
    return normalizeEvmAddress(value);
  }
}
