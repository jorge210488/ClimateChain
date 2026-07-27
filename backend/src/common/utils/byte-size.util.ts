/**
 * Byte-size parsing for configuration values handed to Express.
 *
 * The parser Express uses has two silent failure modes, and they point in
 * opposite directions: a value it cannot read leaves the limit unset (no cap at
 * all), while a near-miss such as `64kbb` reads as 64 *bytes* and rejects every
 * request. Neither is reported as a configuration error, so the value has to be
 * validated before it ever reaches the parser.
 */

const UNIT_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
};

/** Shape accepted: an optional decimal with an optional unit, e.g. 512, 1.5mb. */
export const BYTE_SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s?(b|kb|mb|gb)?$/i;

/**
 * Returns the size in bytes, or `undefined` when the value is not a size this
 * parser recognizes.
 */
export function parseByteSize(value: string): number | undefined {
  const match = BYTE_SIZE_PATTERN.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();

  if (!Number.isFinite(amount)) {
    return undefined;
  }

  return Math.floor(amount * UNIT_MULTIPLIERS[unit]);
}

/**
 * Smallest accepted request body cap.
 *
 * A cap of zero passes a shape check but rejects every non-empty body, which
 * looks like a broken service rather than a misconfiguration. Requiring a
 * plausible floor turns that mistake into a startup error.
 */
export const MIN_REQUEST_BODY_BYTES = 1024;

/**
 * Largest accepted request body cap.
 *
 * This API takes small JSON documents; a cap far above that is more likely a
 * typo (`64mb` for `64kb`) than an intention, and it hands an attacker a cheap
 * memory-pressure lever.
 */
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 ** 2;
