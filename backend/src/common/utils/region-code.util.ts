import { decodeBytes32String, encodeBytes32String } from "ethers";

import { POLICY_DOMAIN } from "../../modules/policies/policy.constants";

/**
 * Region codes cross the API boundary as human-readable strings and the chain
 * boundary as `bytes32`. Encoding is length-prefixed UTF-8, which is why the
 * usable budget is 31 bytes rather than 32.
 *
 * The contract rejects `bytes32(0)`, so an empty region is not merely
 * unrepresentable — it is a value the chain would refuse.
 */

/** The all-zero `bytes32`, which `InsuranceProvider` treats as invalid. */
export const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

/** Encodes a region string to `bytes32`, throwing when it cannot be represented. */
export function encodeRegionCode(region: string): string {
  if (region.length === 0) {
    throw new Error(
      "Region code must not be empty; the chain rejects bytes32(0)",
    );
  }

  const byteLength = Buffer.byteLength(region, "utf8");
  if (byteLength > POLICY_DOMAIN.maxRegionCodeLength) {
    throw new Error(
      `Region code "${region}" is ${byteLength} UTF-8 bytes, exceeding the ` +
        `${POLICY_DOMAIN.maxRegionCodeLength}-byte bytes32 budget`,
    );
  }

  return encodeBytes32String(region);
}

/**
 * Decodes a `bytes32` region code back to a string.
 *
 * Not every on-chain value round-trips: `LEGACY_REGION_CODE` is a keccak hash,
 * and a policy created outside this API could hold arbitrary bytes. Those are
 * not decodable text, so the raw hex is returned rather than throwing or
 * inventing a label — the caller still sees exactly what is on chain.
 */
export function decodeRegionCode(value: string): string | undefined {
  if (value === ZERO_BYTES32) {
    return undefined;
  }

  try {
    const decoded = decodeBytes32String(value);
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}
