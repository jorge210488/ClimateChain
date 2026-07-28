import { createHash } from "node:crypto";

import { ConflictException, Injectable, Logger } from "@nestjs/common";

/** Identifies work already handed to an external system we cannot recall. */
export interface SubmissionHandle {
  /** Transaction hash the node accepted. */
  transactionHash: string;
  /** Chain the transaction was submitted to, when known. */
  chainId?: string;
  /** Nonce it was signed with, when known. */
  nonce?: number;
}

/**
 * Handed to the operation so it can report the point of no return.
 *
 * Everything before {@link markSubmitted} is safely retryable; everything after
 * it is not, because the effect may already exist even if the call fails.
 */
export interface IdempotencyContext {
  markSubmitted(handle: SubmissionHandle): void;
}

interface BaseEntry {
  requestHash: string;
}

interface InFlightEntry extends BaseEntry {
  state: "in-flight";
  startedAt: number;
}

interface SubmittedEntry extends BaseEntry {
  state: "submitted";
  submittedAt: number;
  handle: SubmissionHandle;
}

interface CompletedEntry<T> extends BaseEntry {
  state: "completed";
  completedAt: number;
  result: T;
}

type Entry<T> = InFlightEntry | SubmittedEntry | CompletedEntry<T>;

/**
 * Replay protection for operations that cannot be undone.
 *
 * Policy creation spends the provider's coverage reserve, so a client retrying
 * after a timeout must not end up with two policies. The server side of the
 * `Idempotency-Key` convention: the first request executes, and a repeat with
 * the same key is answered from the record instead of executing again.
 *
 * The record moves through three states, and the middle one is the whole point:
 *
 * ```
 *   in-flight  ──markSubmitted──▶  submitted  ──▶  completed
 *       │                              │
 *   released on failure           kept on failure
 *   (nothing happened)            (it may have happened)
 * ```
 *
 * Once a transaction has been accepted by a node, waiting for its receipt can
 * time out while the transaction still confirms minutes later. Treating that as
 * a plain failure and releasing the key lets a retry submit a *second*
 * transaction, and both can be mined — locking the reserve twice. That is the
 * exact duplicate this class exists to prevent, so a submitted record survives
 * the failure and a retry is told to reconcile the transaction hash rather than
 * being allowed to resubmit.
 *
 * A key is scoped by caller and bound to a hash of the payload: scoping keeps
 * one caller's keys from colliding with another's, and binding turns "same key,
 * different body" into an explicit conflict rather than a result for a request
 * nobody made.
 *
 * **This store is in-process and non-durable.** A restart loses it, and two
 * instances do not share it, so neither protects against a duplicate on its
 * own. Durable idempotency, shared nonce coordination, and mutual exclusion are
 * prerequisites for running more than one instance — see the Stage 06 report.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly entries = new Map<string, Entry<unknown>>();

  /**
   * Retention for records that describe a real effect.
   *
   * Long enough for a client to reconcile, bounded so a long-lived process does
   * not accumulate records forever.
   */
  private static readonly TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * Runs `operation` at most once per (actor, key).
   *
   * The operation receives a context and must call `markSubmitted` as soon as
   * work has been handed to a system that cannot be recalled.
   */
  async execute<T>(
    actor: string,
    key: string | undefined,
    payload: unknown,
    operation: (context: IdempotencyContext) => Promise<T>,
  ): Promise<T> {
    // Idempotency is opt-in at this layer; callers that require it enforce the
    // header at their own boundary (policy creation does).
    if (!key) {
      return operation({ markSubmitted: () => undefined });
    }

    const scopedKey = `${actor}:${key}`;
    const requestHash = this.hashPayload(payload);
    this.evictExpired();

    const existing = this.entries.get(scopedKey);
    if (existing) {
      return this.replay<T>(existing, key, requestHash);
    }

    this.entries.set(scopedKey, {
      state: "in-flight",
      requestHash,
      startedAt: Date.now(),
    });

    let submitted: SubmissionHandle | undefined;
    const context: IdempotencyContext = {
      markSubmitted: (handle) => {
        submitted = handle;
        this.entries.set(scopedKey, {
          state: "submitted",
          requestHash,
          submittedAt: Date.now(),
          handle,
        });
        this.logger.log(
          `Idempotency-Key "${key}" reached submission: tx=${handle.transactionHash}`,
        );
      },
    };

    try {
      const result = await operation(context);
      this.entries.set(scopedKey, {
        state: "completed",
        requestHash,
        completedAt: Date.now(),
        result,
      });
      return result;
    } catch (error) {
      if (submitted) {
        // The effect may exist. Keeping the record is what stops a retry from
        // producing a second one; the client is pointed at the hash instead.
        this.logger.warn(
          `Idempotency-Key "${key}" failed after submission ` +
            `(tx=${submitted.transactionHash}); the record is retained so a ` +
            `retry cannot submit again.`,
        );
      } else {
        // Nothing was signed, so nothing can be in flight and the same key must
        // stay usable. This holds only because the operation reports submission
        // from the moment a transaction is *signed*, not when a node confirms
        // receipt: a hash learned from the response would leave a lost reply
        // indistinguishable from a clean failure, and releasing the key there
        // would let the retry duplicate the effect.
        this.entries.delete(scopedKey);
      }
      throw error;
    }
  }

  /** Answers a repeat from the existing record. */
  private replay<T>(
    existing: Entry<unknown>,
    key: string,
    requestHash: string,
  ): T {
    if (existing.requestHash !== requestHash) {
      throw new ConflictException(
        `Idempotency-Key "${key}" was already used with a different request ` +
          `body. Use a new key for a different request.`,
      );
    }

    if (existing.state === "completed") {
      this.logger.log(`Replaying stored result for Idempotency-Key "${key}"`);
      return existing.result as T;
    }

    if (existing.state === "submitted") {
      throw new ConflictException(
        `A transaction for Idempotency-Key "${key}" was already submitted ` +
          `(hash ${existing.handle.transactionHash}) but its outcome is not ` +
          `confirmed. Check that transaction before retrying: resubmitting ` +
          `would risk creating a second policy.`,
      );
    }

    // Still executing. Reported rather than awaited, so a retry does not hold a
    // second connection open for the length of a chain write.
    throw new ConflictException(
      `A request with Idempotency-Key "${key}" is still in progress. Retry ` +
        `once it completes.`,
    );
  }

  /** Stable hash of the request body, insensitive to key ordering. */
  private hashPayload(payload: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify(payload, Object.keys(payload ?? {}).sort()))
      .digest("hex");
  }

  /**
   * Drops records that have outlived their retention.
   *
   * Only terminal states expire. An `in-flight` record is never released on a
   * timer: this store lives in the process running the operation, so a record
   * that is still in-flight means the operation is still running, and a clock
   * cannot tell a slow operation from an abandoned one. If the process dies the
   * whole map dies with it, so there is nothing to reclaim.
   *
   * Runs on access rather than on an interval, which would keep the event loop
   * alive for a map only ever touched during a request.
   */
  private evictExpired(): void {
    const now = Date.now();

    for (const [key, entry] of this.entries) {
      if (entry.state === "in-flight") {
        continue;
      }

      const age =
        entry.state === "completed"
          ? now - entry.completedAt
          : now - entry.submittedAt;

      if (age > IdempotencyService.TERMINAL_TTL_MS) {
        this.entries.delete(key);
      }
    }
  }
}
