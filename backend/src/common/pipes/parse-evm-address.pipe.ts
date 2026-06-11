import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";

import { isEvmAddress } from "../utils/evm-address.util";

/** Validates and normalizes a route/query parameter as an EVM address. */
@Injectable()
export class ParseEvmAddressPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isEvmAddress(value)) {
      throw new BadRequestException(
        `"${value}" is not a valid 0x-prefixed 20-byte EVM address`,
      );
    }
    return value;
  }
}
