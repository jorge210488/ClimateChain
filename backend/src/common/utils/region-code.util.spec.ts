import { keccak256, toUtf8Bytes } from "ethers";

import { POLICY_DOMAIN } from "../../modules/policies/policy.constants";
import {
  ZERO_BYTES32,
  decodeRegionCode,
  encodeRegionCode,
} from "./region-code.util";

describe("encodeRegionCode", () => {
  it("encodes a region to a 32-byte value", () => {
    const encoded = encodeRegionCode("Valencia");

    expect(encoded).toMatch(/^0x[0-9a-f]{64}$/);
    // "Valencia" in UTF-8, right-padded with zeros.
    expect(encoded.startsWith("0x56616c656e636961")).toBe(true);
  });

  it("round-trips through decoding", () => {
    for (const region of ["Valencia", "A", "Buenos Aires", "x".repeat(31)]) {
      expect(decodeRegionCode(encodeRegionCode(region))).toBe(region);
    }
  });

  it("accepts a region at exactly the byte budget", () => {
    const atLimit = "x".repeat(POLICY_DOMAIN.maxRegionCodeLength);
    expect(() => encodeRegionCode(atLimit)).not.toThrow();
  });

  it("rejects a region one byte over the budget", () => {
    const overLimit = "x".repeat(POLICY_DOMAIN.maxRegionCodeLength + 1);
    expect(() => encodeRegionCode(overLimit)).toThrow(/32 UTF-8 bytes/);
  });

  it("measures multibyte characters in bytes, not characters", () => {
    // 16 characters but 32 UTF-8 bytes: counting characters would let this
    // through and the encoding would then fail at the chain boundary.
    expect(() => encodeRegionCode("ñ".repeat(16))).toThrow(/32 UTF-8 bytes/);
    expect(() => encodeRegionCode("ñ".repeat(15))).not.toThrow();
  });

  it("rejects an empty region", () => {
    // bytes32(0) is the value InsuranceProvider explicitly refuses.
    expect(() => encodeRegionCode("")).toThrow(/bytes32\(0\)/);
  });
});

describe("decodeRegionCode", () => {
  it("returns undefined for the zero value", () => {
    expect(decodeRegionCode(ZERO_BYTES32)).toBeUndefined();
  });

  it("returns undefined for a non-decodable value", () => {
    // LEGACY_REGION_CODE is keccak256("LEGACY_UNSPECIFIED"), a hash rather than
    // text: policies created through the legacy entry point carry it, and the
    // API must surface the raw code instead of inventing a label.
    const legacy = keccak256(toUtf8Bytes("LEGACY_UNSPECIFIED"));
    expect(decodeRegionCode(legacy)).toBeUndefined();
  });

  it("returns undefined rather than throwing on malformed input", () => {
    expect(decodeRegionCode("0xnot-hex")).toBeUndefined();
    expect(decodeRegionCode("0x00")).toBeUndefined();
  });
});
