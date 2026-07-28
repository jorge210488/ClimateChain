import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Interface } from "ethers";

import { isTransientRpcError } from "./chain-retry.util";

/**
 * Translates chain failures into the API's error contract.
 *
 * A raw revert is useless to a caller: ethers surfaces it as `CALL_EXCEPTION`
 * with hex data, and without the ABI nobody can tell "your premium was too low"
 * (the caller's fault, fixable) from "the reserve is empty" (the operator's
 * fault, not fixable by retrying). Decoding the custom error and mapping it to
 * a status is what makes reverts actionable.
 */

/** How each on-chain custom error surfaces over HTTP. */
interface RevertMapping {
  status: "bad-request" | "conflict" | "not-found" | "unavailable";
  /** Caller-facing explanation; on-chain arguments are appended when present. */
  message: string;
}

/**
 * `InsuranceProvider` and `InsurancePolicy` custom errors.
 *
 * The split is by *who can act on it*: 400 means the request was wrong and the
 * caller can fix it, 409 means the request was valid but conflicts with current
 * on-chain state, 503 means the operator must act (funding, configuration) and
 * the caller can only wait.
 */
const REVERT_MAPPINGS: Record<string, RevertMapping> = {
  // --- Caller-fixable input errors ---
  InvalidCoverageAmount: {
    status: "bad-request",
    message: "Coverage amount must be greater than zero",
  },
  InvalidDurationDays: {
    status: "bad-request",
    message: "Policy duration must be greater than zero",
  },
  DurationDaysExceedsMaximum: {
    status: "bad-request",
    message: "Policy duration exceeds the maximum allowed by the contract",
  },
  InvalidRainfallThreshold: {
    status: "bad-request",
    message: "Rainfall threshold must be greater than zero",
  },
  InvalidRegionCode: {
    status: "bad-request",
    message: "Region code must not be empty",
  },
  InvalidRequestedStartTimestamp: {
    status: "bad-request",
    message:
      "Requested start timestamp is inside the minimum lead-time window; " +
      "submit a later start",
  },
  RequestedStartTooFarInFuture: {
    status: "bad-request",
    message:
      "Requested start timestamp is beyond the maximum the contract allows; " +
      "coverage cannot be reserved that far ahead",
  },
  PremiumMustBePositive: {
    status: "bad-request",
    message: "Premium must be greater than zero",
  },
  PremiumBelowMinimum: {
    status: "bad-request",
    message: "Premium is below the minimum ratio required for this coverage",
  },
  InvalidPolicyWindowComputation: {
    status: "bad-request",
    message:
      "Requested start and duration produce an out-of-range policy window",
  },
  InvalidPolicyWindow: {
    status: "bad-request",
    message: "Policy start must be strictly before its end",
  },
  InvalidPremiumAmount: {
    status: "bad-request",
    message: "Premium must be greater than zero",
  },
  InvalidInsuredAddress: {
    status: "bad-request",
    message: "Insured address must not be the zero address",
  },
  InvalidRecipientAddress: {
    status: "bad-request",
    message: "Recipient address must not be the zero address",
  },
  InvalidWithdrawalAmount: {
    status: "bad-request",
    message: "Withdrawal amount must be greater than zero",
  },

  // --- Unknown subject ---
  UnknownPolicyAddress: {
    status: "not-found",
    message: "No policy with that address was created by this provider",
  },
  PolicyIndexOutOfBounds: {
    status: "not-found",
    message: "Policy index is out of range",
  },

  // --- Conflicts with current on-chain state ---
  PolicyAlreadySettledInProvider: {
    status: "conflict",
    message: "Policy has already been settled by the provider",
  },
  PolicyAlreadySettled: {
    status: "conflict",
    message: "Policy has already been settled",
  },
  PolicyNotActivated: {
    status: "conflict",
    message: "Policy has not been activated yet",
  },
  PolicyNotEnded: {
    status: "conflict",
    message: "Policy coverage window has not ended yet",
  },
  TriggeredPolicyRequiresPayout: {
    status: "conflict",
    message: "Triggered policy must be paid out rather than expired",
  },
  InvalidStatus: {
    status: "conflict",
    message: "Policy is not in the status this operation requires",
  },
  PolicyOutsideWeatherWindow: {
    status: "conflict",
    message: "Operation is only allowed inside the policy weather window",
  },
  PendingPayoutNotAvailable: {
    status: "conflict",
    message: "No pending payout is available to claim",
  },
  PendingPayoutStillClaimable: {
    status: "conflict",
    message:
      "The insured can still claim this payout; recovery is not available yet",
  },
  NoPendingWeatherRequest: {
    status: "conflict",
    message: "No weather request is currently pending for this policy",
  },
  InvalidWeatherRequestId: {
    status: "conflict",
    message: "Weather request id does not match the policy's pending request",
  },

  // --- Operator must act ---
  InsufficientCoverageReserve: {
    status: "unavailable",
    message:
      "The provider's coverage reserve cannot back this policy; the operator " +
      "must fund the reserve before new policies can be created",
  },
  InsufficientPremiumBalance: {
    status: "unavailable",
    message:
      "The provider's premium balance is insufficient for this operation",
  },
  InsufficientUntrackedBalance: {
    status: "unavailable",
    message:
      "The provider's untracked balance is insufficient for this operation",
  },
  TrackedBalanceDeficit: {
    status: "unavailable",
    message:
      "The provider's tracked balances exceed its on-chain balance; " +
      "operations are halted until the deficit is resolved",
  },
  EthTransferFailed: {
    status: "unavailable",
    message: "An on-chain ETH transfer failed",
  },
  InvalidOracleAddress: {
    status: "unavailable",
    message: "The configured weather oracle address is not a valid contract",
  },
  SameOracleAddress: {
    status: "conflict",
    message: "The weather oracle is already set to that address",
  },
  OracleOnly: {
    status: "conflict",
    message: "Only the policy's oracle may perform this operation",
  },
  InsuredOnly: {
    status: "conflict",
    message: "Only the insured account may perform this operation",
  },

  // --- Internal accounting inconsistencies ---
  // The provider computes these amounts itself, so a mismatch means deployed
  // contract state disagrees with itself. Nothing the caller sends changes it.
  CoverageReserveMismatch: {
    status: "unavailable",
    message:
      "The coverage amount forwarded on policy deployment did not match the " +
      "amount reserved; the provider's accounting is inconsistent",
  },
  PremiumMismatch: {
    status: "unavailable",
    message:
      "The premium forwarded on activation did not match the amount the " +
      "policy expects; the provider's accounting is inconsistent",
  },

  // --- OpenZeppelin base contracts ---
  // Reachable through inherited Ownable/ReentrancyGuard rather than declared by
  // the project's own contracts, but they arrive over the same revert path and
  // would otherwise surface as an unexplained generic error.
  OwnableUnauthorizedAccount: {
    status: "unavailable",
    message:
      "The configured signer is not the owner of the provider contract, so it " +
      "cannot perform this operation; check PRIVATE_KEY against the deployed owner",
  },
  OwnableInvalidOwner: {
    status: "unavailable",
    message: "The provider contract has an invalid owner configured",
  },
  ReentrancyGuardReentrantCall: {
    status: "conflict",
    message:
      "The contract rejected a reentrant call; another operation on this " +
      "contract is still in progress",
  },
};

/**
 * Transaction-submission failures, keyed by ethers error code.
 *
 * These happen before the contract runs, so there is no revert data to decode,
 * yet each has a specific operational cause worth naming.
 */
const SUBMISSION_FAILURES: Record<string, RevertMapping> = {
  NONCE_EXPIRED: {
    status: "conflict",
    message:
      "The transaction nonce was already used. Another process is submitting " +
      "with the same signer; give each instance its own signing account or " +
      "coordinate nonces externally.",
  },
  REPLACEMENT_UNDERPRICED: {
    status: "conflict",
    message:
      "A transaction with this nonce is already pending and the replacement " +
      "fee is too low. Wait for the pending transaction to confirm.",
  },
  INSUFFICIENT_FUNDS: {
    status: "unavailable",
    message:
      "The configured signer has insufficient balance to pay for this " +
      "transaction; fund the signing account.",
  },
  TRANSACTION_REPLACED: {
    status: "conflict",
    message:
      "The submitted transaction was replaced before confirming; verify " +
      "on-chain state before resubmitting.",
  },

  // Argument encoding failures. Reached only when a value survives DTO
  // validation and is still not representable on chain — an out-of-range
  // integer, for instance. That is a bad input, so it must not be reported as a
  // server fault; the DTO rules are the primary defense and this is the backstop.
  INVALID_ARGUMENT: {
    status: "bad-request",
    message:
      "A request value cannot be encoded for the contract call; check that " +
      "numeric fields are within range",
  },
  NUMERIC_FAULT: {
    status: "bad-request",
    message:
      "A numeric request value is out of range for the contract call " +
      "(overflow or underflow)",
  },
};

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** A decoded revert, before it becomes an HTTP exception. */
export interface DecodedRevert {
  name: string;
  args: Record<string, string>;
  mapping?: RevertMapping;
}

function readRevertData(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as {
    data?: unknown;
    info?: { error?: { data?: unknown } };
  };
  if (typeof candidate.data === "string" && candidate.data.length > 2) {
    return candidate.data;
  }

  // Some providers nest the revert payload one level deeper.
  const nested = candidate.info?.error?.data;
  return typeof nested === "string" && nested.length > 2 ? nested : undefined;
}

/**
 * Decodes revert data against the given interfaces.
 *
 * Both provider and policy interfaces are tried because a provider call can
 * bubble a revert raised inside the policy contract it just invoked.
 */
export function decodeRevert(
  error: unknown,
  interfaces: Interface[],
): DecodedRevert | undefined {
  const data = readRevertData(error);
  if (!data) {
    return undefined;
  }

  for (const iface of interfaces) {
    const parsed = iface.parseError(data);
    if (!parsed) {
      continue;
    }

    const args: Record<string, string> = {};
    parsed.fragment.inputs.forEach((input, index) => {
      args[input.name || `arg${index}`] = String(parsed.args[index]);
    });

    return { name: parsed.name, args, mapping: REVERT_MAPPINGS[parsed.name] };
  }

  return undefined;
}

function buildMessage(decoded: DecodedRevert): string {
  const base = decoded.mapping?.message ?? `Contract reverted: ${decoded.name}`;
  const args = Object.entries(decoded.args);
  if (args.length === 0) {
    return base;
  }
  const detail = args.map(([key, value]) => `${key}=${value}`).join(", ");
  return `${base} (${decoded.name}: ${detail})`;
}

function toException(
  status: RevertMapping["status"],
  message: string,
): HttpException {
  switch (status) {
    case "bad-request":
      return new BadRequestException(message);
    case "conflict":
      return new ConflictException(message);
    case "not-found":
      return new NotFoundException(message);
    case "unavailable":
      return new ServiceUnavailableException(message);
  }
}

/**
 * Converts any chain failure into an `HttpException`.
 *
 * Ordering is deliberate: an already-mapped exception passes through untouched,
 * a decodable revert becomes its mapped status, a transient RPC failure becomes
 * 503 (the caller may retry), and anything else becomes 500 without leaking
 * node internals into the response.
 */
export function toHttpException(
  error: unknown,
  interfaces: Interface[],
  context: string,
): HttpException {
  if (error instanceof HttpException) {
    return error;
  }

  const decoded = decodeRevert(error, interfaces);
  if (decoded) {
    const message = buildMessage(decoded);
    // An undecorated revert is still the contract refusing the request, so it
    // is a client error by default rather than a server fault.
    return toException(decoded.mapping?.status ?? "bad-request", message);
  }

  if (isTransientRpcError(error)) {
    return new ServiceUnavailableException(
      `The blockchain node is unreachable or not responding (${context}). ` +
        `The request can be retried.`,
    );
  }

  // Submission-level failures. These carry no revert data, so without explicit
  // handling they would surface as an opaque 500 and hide an operational cause
  // that is both diagnosable and actionable.
  const submissionFailure = SUBMISSION_FAILURES[readErrorCode(error) ?? ""];
  if (submissionFailure) {
    return toException(submissionFailure.status, submissionFailure.message);
  }

  // Nothing recognized it. The response stays generic so node internals are
  // not exposed, but the cause is preserved on the exception so the global
  // filter logs it with a stack — otherwise a 500 here would be undebuggable.
  return new InternalServerErrorException(
    `Unexpected failure while communicating with the blockchain (${context})`,
    { cause: error instanceof Error ? error : new Error(String(error)) },
  );
}

/** Exposed for tests and documentation of the mapping surface. */
export const KNOWN_REVERT_NAMES = Object.keys(REVERT_MAPPINGS);
