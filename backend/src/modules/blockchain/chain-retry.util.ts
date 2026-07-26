/**
 * Retry policy for RPC calls.
 *
 * The distinction that matters here is transient (the node was unreachable,
 * slow, or rate-limiting) versus deterministic (the contract reverted, the
 * arguments were wrong). Retrying a revert is pointless — it will revert
 * identically every time — and it multiplies latency on the exact requests that
 * are already failing. Only transient conditions are retried.
 */

/** Error codes ethers surfaces for conditions that may succeed on a retry. */
const TRANSIENT_ETHERS_CODES = new Set([
  "NETWORK_ERROR",
  "SERVER_ERROR",
  "TIMEOUT",
  "UNKNOWN_ERROR",
]);

/** Node-level socket failures that never reached the RPC endpoint. */
const TRANSIENT_SYSTEM_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * Deterministic ethers codes. Listed explicitly rather than inferred, so a new
 * ethers code defaults to "do not retry" instead of silently being hammered.
 */
const PERMANENT_ETHERS_CODES = new Set([
  "CALL_EXCEPTION",
  "INSUFFICIENT_FUNDS",
  "NONCE_EXPIRED",
  "REPLACEMENT_UNDERPRICED",
  "TRANSACTION_REPLACED",
  "UNPREDICTABLE_GAS_LIMIT",
  "INVALID_ARGUMENT",
  "MISSING_ARGUMENT",
  "UNEXPECTED_ARGUMENT",
  "VALUE_MISMATCH",
  "ACTION_REJECTED",
  "NOT_IMPLEMENTED",
  "UNSUPPORTED_OPERATION",
  "BAD_DATA",
]);

function readCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** True when the failure could plausibly succeed if attempted again. */
export function isTransientRpcError(error: unknown): boolean {
  const code = readCode(error);

  if (code !== undefined) {
    if (PERMANENT_ETHERS_CODES.has(code)) {
      return false;
    }
    if (TRANSIENT_ETHERS_CODES.has(code) || TRANSIENT_SYSTEM_CODES.has(code)) {
      return true;
    }
  }

  // Some providers wrap the socket failure; check the cause chain once.
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause !== undefined && cause !== null) {
    const causeCode = readCode(cause);
    if (causeCode !== undefined && TRANSIENT_SYSTEM_CODES.has(causeCode)) {
      return true;
    }
  }

  return false;
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  /** Invoked before each retry, for logging. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  /** Injected in tests to avoid real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests to make jitter deterministic. */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `operation`, retrying only transient failures with exponential backoff.
 *
 * Backoff is jittered: without it, several requests failing at the same moment
 * would retry in lockstep and hit the recovering node as a synchronized burst.
 */
export async function withRpcRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    attempts,
    baseDelayMs,
    onRetry,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isTransientRpcError(error) || attempt === attempts) {
        throw error;
      }

      const exponential = baseDelayMs * 2 ** (attempt - 1);
      // Full jitter over the exponential window.
      const delayMs = Math.round(exponential * (0.5 + random() * 0.5));
      onRetry?.(attempt, delayMs, error);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
