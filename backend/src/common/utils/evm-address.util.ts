const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Returns true when `value` is a syntactically valid 20-byte hex address. */
export function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && EVM_ADDRESS_PATTERN.test(value);
}

/** Returns true when `value` is the zero address. */
export function isZeroAddress(value: string): boolean {
  return value.toLowerCase() === ZERO_ADDRESS;
}

/**
 * Validates an address is well-formed and non-zero.
 * Throws an `Error` with an actionable message otherwise.
 */
export function assertUsableAddress(value: unknown, label: string): string {
  if (!isEvmAddress(value)) {
    throw new Error(
      `${label} is not a valid 0x-prefixed 20-byte address (received: ${String(
        value,
      )})`,
    );
  }
  if (isZeroAddress(value)) {
    throw new Error(`${label} must not be the zero address`);
  }
  return value;
}
