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

const WEI_PER_ETH = 10n ** 18n;
const ETH_DECIMALS = 18;

/**
 * Parses a decimal ETH amount string into wei (bigint). The input must match
 * {@link POSITIVE_ETH_AMOUNT_REGEX}; throws otherwise so callers can defer to
 * the format validator.
 */
export function parseEthToWei(amount: string): bigint {
  if (!POSITIVE_ETH_AMOUNT_REGEX.test(amount)) {
    throw new Error(`Invalid ETH amount: ${amount}`);
  }
  const [whole, fraction = ""] = amount.split(".");
  const paddedFraction = `${fraction}${"0".repeat(ETH_DECIMALS)}`.slice(
    0,
    ETH_DECIMALS,
  );
  return BigInt(whole) * WEI_PER_ETH + BigInt(paddedFraction);
}
