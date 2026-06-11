/**
 * Positive decimal ETH amount as a string (avoids floating-point precision
 * loss). Rejects zero and more than 18 fractional digits.
 */
export const POSITIVE_ETH_AMOUNT_REGEX =
  /^(?!0+(\.0+)?$)\d{1,30}(\.\d{1,18})?$/;

/** Builds a consistent validation message for an ETH amount field. */
export function ethAmountMessage(field: string): string {
  return `${field} must be a positive decimal string with up to 18 fractional digits`;
}
