import { BadRequestException } from "@nestjs/common";

import { ParseEvmAddressPipe } from "../pipes/parse-evm-address.pipe";
import {
  assertUsableAddress,
  isEvmAddress,
  isZeroAddress,
  normalizeEvmAddress,
} from "./evm-address.util";

const CHECKSUMMED = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const LOWERCASE = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const ZERO = "0x0000000000000000000000000000000000000000";

describe("isEvmAddress", () => {
  it.each([
    CHECKSUMMED,
    LOWERCASE,
    CHECKSUMMED.toUpperCase().replace("0X", "0x"),
  ])("accepts %s regardless of casing", (address) => {
    expect(isEvmAddress(address)).toBe(true);
  });

  it.each([
    "not-an-address",
    "0x123",
    `${CHECKSUMMED}00`,
    "f39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "",
    null,
    undefined,
    42,
  ])("rejects %p", (value) => {
    expect(isEvmAddress(value)).toBe(false);
  });
});

describe("normalizeEvmAddress", () => {
  it("folds checksum casing to a single comparable form", () => {
    // The point of normalization: the same account spelled two ways must not
    // compare as two different accounts.
    expect(normalizeEvmAddress(CHECKSUMMED)).toBe(LOWERCASE);
    expect(normalizeEvmAddress(CHECKSUMMED)).toBe(
      normalizeEvmAddress(LOWERCASE),
    );
  });

  it("is idempotent", () => {
    expect(normalizeEvmAddress(normalizeEvmAddress(CHECKSUMMED))).toBe(
      LOWERCASE,
    );
  });
});

describe("isZeroAddress", () => {
  it("detects the zero address in any casing", () => {
    expect(isZeroAddress(ZERO)).toBe(true);
    expect(isZeroAddress(CHECKSUMMED)).toBe(false);
  });
});

describe("assertUsableAddress", () => {
  it("returns a well-formed non-zero address unchanged", () => {
    expect(assertUsableAddress(CHECKSUMMED, "provider")).toBe(CHECKSUMMED);
  });

  it("names the offending field when malformed", () => {
    expect(() => assertUsableAddress("nope", "provider address")).toThrow(
      /provider address/,
    );
  });

  it("rejects the zero address as unusable", () => {
    expect(() => assertUsableAddress(ZERO, "oracle address")).toThrow(
      /must not be the zero address/,
    );
  });
});

describe("ParseEvmAddressPipe", () => {
  const pipe = new ParseEvmAddressPipe();

  it("normalizes an accepted address", () => {
    expect(pipe.transform(CHECKSUMMED)).toBe(LOWERCASE);
  });

  it("rejects a malformed address with 400", () => {
    expect(() => pipe.transform("not-an-address")).toThrow(BadRequestException);
  });
});
