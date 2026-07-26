import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Interface } from "ethers";

import {
  KNOWN_REVERT_NAMES,
  decodeRevert,
  toHttpException,
} from "./chain-error.mapper";

/** Loads a real exported ABI so the mapping is tested against actual encoding. */
function loadInterface(contractName: string): Interface {
  const path = resolve(
    process.cwd(),
    "..",
    "shared",
    "abi",
    `${contractName}.json`,
  );
  const artifact = JSON.parse(readFileSync(path, "utf-8")) as {
    abi: unknown[];
  };
  return new Interface(artifact.abi as never);
}

const providerInterface = loadInterface("InsuranceProvider");
const policyInterface = loadInterface("InsurancePolicy");
const interfaces = [providerInterface, policyInterface];

/** Builds the error shape ethers produces for a revert. */
function revertError(iface: Interface, name: string, args: unknown[]): Error {
  return Object.assign(new Error("execution reverted"), {
    code: "CALL_EXCEPTION",
    data: iface.encodeErrorResult(name, args),
  });
}

describe("decodeRevert", () => {
  it("decodes a provider custom error with its arguments", () => {
    const error = revertError(
      providerInterface,
      "InsufficientCoverageReserve",
      [1_000n, 5_000n],
    );

    const decoded = decodeRevert(error, interfaces);

    expect(decoded?.name).toBe("InsufficientCoverageReserve");
    expect(decoded?.args).toEqual({
      available: "1000",
      requiredAmount: "5000",
    });
  });

  it("decodes an error raised inside the policy contract", () => {
    // A provider call can bubble a revert from the policy it invoked, so both
    // interfaces must be consulted rather than only the one called directly.
    const error = revertError(policyInterface, "InvalidStatus", [1, 3]);

    expect(decodeRevert(error, interfaces)?.name).toBe("InvalidStatus");
  });

  it("reads revert data nested under info.error", () => {
    const data = providerInterface.encodeErrorResult(
      "PremiumMustBePositive",
      [],
    );
    const error = Object.assign(new Error("reverted"), {
      code: "CALL_EXCEPTION",
      info: { error: { data } },
    });

    expect(decodeRevert(error, interfaces)?.name).toBe("PremiumMustBePositive");
  });

  it("returns undefined when there is no revert data", () => {
    expect(decodeRevert(new Error("network down"), interfaces)).toBeUndefined();
    expect(decodeRevert({ data: "0x" }, interfaces)).toBeUndefined();
    expect(decodeRevert(null, interfaces)).toBeUndefined();
  });

  it("returns undefined for data no interface recognizes", () => {
    const error = { code: "CALL_EXCEPTION", data: "0xdeadbeef" };
    expect(decodeRevert(error, interfaces)).toBeUndefined();
  });
});

describe("toHttpException", () => {
  it.each([
    ["InvalidCoverageAmount", [], BadRequestException, 400],
    ["PremiumMustBePositive", [], BadRequestException, 400],
    ["UnknownPolicyAddress", ["0x" + "11".repeat(20)], NotFoundException, 404],
    [
      "PolicyAlreadySettledInProvider",
      ["0x" + "11".repeat(20)],
      ConflictException,
      409,
    ],
    ["InsufficientCoverageReserve", [1n, 2n], ServiceUnavailableException, 503],
  ] as const)(
    "maps %s to HTTP %s",
    (name, args, expectedType, expectedStatus) => {
      const exception = toHttpException(
        revertError(providerInterface, name, [...args]),
        interfaces,
        "test",
      );

      expect(exception).toBeInstanceOf(expectedType);
      expect(exception.getStatus()).toBe(expectedStatus);
    },
  );

  it("includes the on-chain argument values in the message", () => {
    // The numbers are the actionable part: "fund the reserve" is not useful
    // without knowing how short it is.
    const exception = toHttpException(
      revertError(providerInterface, "InsufficientCoverageReserve", [7n, 99n]),
      interfaces,
      "createPolicy",
    );

    expect(exception.message).toContain("available=7");
    expect(exception.message).toContain("requiredAmount=99");
  });

  it("treats an unmapped but decodable revert as a client error", () => {
    // The contract refused the request; absent an explicit mapping the safer
    // default is 400, not blaming the server for a rejected input.
    const exception = toHttpException(
      revertError(providerInterface, "InvalidPolicyWindowComputation", [1n, 2]),
      interfaces,
      "test",
    );

    expect(exception.getStatus()).toBe(400);
  });

  it("maps a transient RPC failure to 503 and says it can be retried", () => {
    const exception = toHttpException(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      interfaces,
      "listPolicies",
    );

    expect(exception).toBeInstanceOf(ServiceUnavailableException);
    expect(exception.message).toContain("retried");
  });

  it("maps an unrecognized failure to 500 without leaking node internals", () => {
    const exception = toHttpException(
      new Error("connect ECONNREFUSED 10.0.0.5:8545 internal-node.local"),
      interfaces,
      "getPolicy",
    );

    expect(exception).toBeInstanceOf(InternalServerErrorException);
    expect(exception.message).not.toContain("10.0.0.5");
    expect(exception.message).not.toContain("internal-node.local");
  });

  it.each([
    ["NONCE_EXPIRED", 409, /nonce/i],
    ["REPLACEMENT_UNDERPRICED", 409, /pending/i],
    ["INSUFFICIENT_FUNDS", 503, /fund the signing account/i],
    ["TRANSACTION_REPLACED", 409, /replaced/i],
  ] as const)(
    "maps submission failure %s to %i with an actionable message",
    (code, status, pattern) => {
      // These carry no revert data, so without explicit handling they would
      // surface as an opaque 500 and hide a diagnosable operational cause.
      const exception = toHttpException(
        Object.assign(new Error("submission failed"), { code }),
        interfaces,
        "createPolicy",
      );

      expect(exception.getStatus()).toBe(status);
      expect(exception.message).toMatch(pattern);
    },
  );

  it("passes an already-mapped HttpException through unchanged", () => {
    const original = new NotFoundException("policy missing");
    expect(toHttpException(original, interfaces, "test")).toBe(original);
  });

  it("returns an HttpException for every input shape", () => {
    for (const input of [undefined, null, "boom", 42, {}, []]) {
      expect(toHttpException(input, interfaces, "test")).toBeInstanceOf(
        HttpException,
      );
    }
  });
});

describe("revert mapping coverage", () => {
  it("maps every custom error declared by both contracts", () => {
    // Guards against a contract adding an error that would surface as a bare
    // 400 with no explanation. If this fails, add the new error to the map.
    const declared = new Set<string>();
    for (const iface of interfaces) {
      iface.forEachError((fragment) => declared.add(fragment.name));
    }

    const unmapped = [...declared].filter(
      (name) => !KNOWN_REVERT_NAMES.includes(name),
    );

    expect(unmapped).toEqual([]);
  });
});
