import { createHash } from "node:crypto";

import { ConflictException, Injectable, Logger } from "@nestjs/common";

/** Outcome recorded for a completed request. */
interface CompletedEntry<T> {
  state: "completed";
  requestHash: string;
  result: T;
  completedAt: number;
}

/** A request that is still executing. */
interface InFlightEntry {
  state: "in-flight";
  requestHash: string;
  startedAt: number;
}

type Entry<T> = CompletedEntry<T> | InFlightEntry;

/**
 * Replay protection for non-idempotent operations.
 *
 * Policy creation spends the provider's coverage reserve, so a client that
 * retries after a timeout must not end up with two policies. HTTP has a
 * convention for this — an `Idempotency-Key` header — and this implements the
 * server side of it: the first request executes, and a repeat with the same key
 * returns the original result instead of executing again.
 *
 * The key is scoped by caller and bound to a hash of the payload. Scoping stops
 * one caller's key from colliding with another's; binding to the payload turns
 * "same key, different body" into an explicit 409 rather than silently
 * returning a result for a request that was never made.
 *
 * **This store is in-process and non-durable.** It defends the case that
 * actually happens — a client retrying seconds after a timeout — and does not
 * survive a restart or span multiple instances. That is a real limit, not an
 * oversight: durable idempotency needs the datastore that arrives with Stage 11,
 * and until then a second instance or a restart can still admit a duplicate.
 * The header is therefore a strong mitigation, not a guarantee.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly entries = new Map<string, Entry<unknown>>();

  /**
   * How long a record is honored. Long enough to cover client retry windows and
   * short enough that the map cannot grow without bound in a long-lived process.
   */
  private static readonly TTL_MS = 24 * 60 * 60 * 1000;

  /** Requests older than this with no outcome are treated as abandoned. */
  private static readonly IN_FLIGHT_TIMEOUT_MS = 5 * 60 * 1000;

  /**
   * Runs `operation` at most once per (actor, key), returning the first result
   * for any later repeat.
   *
   * When no key is supplied the operation simply runs: idempotency is opt-in, so
   * a caller that does not ask for it is not silently given different semantics.
   */
  async execute<T>(
    actor: string,
    key: string | undefined,
    payload: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!key) {
      return operation();
    }

    const scopedKey = `${actor}:${key}`;
    const requestHash = this.hashPayload(payload);
    this.evictExpired();

    const existing = this.entries.get(scopedKey);

    if (existing) {
      if (existing.requestHash !== requestHash) {
        // Reusing a key for a different body is a client bug. Returning the
        // stored result would answer a question that was never asked.
        throw new ConflictException(
          `Idempotency-Key "${key}" was already used with a different request ` +
            `body. Use a new key for a different request.`,
        );
      }

      if (existing.state === "completed") {
        this.logger.log(
          `Replaying stored result for Idempotency-Key "${key}" (actor=${actor})`,
        );
        return existing.result as T;
      }

      // Still running. Reporting 409 rather than waiting keeps the retry from
      // holding a second connection open for the duration of a chain write.
      throw new ConflictException(
        `A request with Idempotency-Key "${key}" is still in progress. Retry ` +
          `once it completes.`,
      );
    }

    this.entries.set(scopedKey, {
      state: "in-flight",
      requestHash,
      startedAt: Date.now(),
    });

    try {
      const result = await operation();
      this.entries.set(scopedKey, {
        state: "completed",
        requestHash,
        result,
        completedAt: Date.now(),
      });
      return result;
    } catch (error) {
      // Failures are not recorded: the operation did not take effect, so the
      // caller must be free to retry the same key. Only success is replayable.
      this.entries.delete(scopedKey);
      throw error;
    }
  }

  /** Stable hash of the request body, insensitive to key ordering. */
  private hashPayload(payload: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify(payload, Object.keys(payload ?? {}).sort()))
      .digest("hex");
  }

  /**
   * Drops expired records.
   *
   * Runs on access rather than on a timer: a background interval would keep the
   * event loop alive and complicate shutdown for a map that is only ever read
   * during a request.
   */
  private evictExpired(): void {
    const now = Date.now();

    for (const [key, entry] of this.entries) {
      const expired =
        entry.state === "completed"
          ? now - entry.completedAt > IdempotencyService.TTL_MS
          : now - entry.startedAt > IdempotencyService.IN_FLIGHT_TIMEOUT_MS;

      if (expired) {
        this.entries.delete(key);
      }
    }
  }
}
