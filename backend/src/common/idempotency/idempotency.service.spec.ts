import { ConflictException, Logger } from "@nestjs/common";

import { IdempotencyService } from "./idempotency.service";

const PAYLOAD = { coverageEth: "1.0", premiumEth: "0.05" };

describe("IdempotencyService", () => {
  let service: IdempotencyService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    service = new IdempotencyService();
  });

  it("runs the operation when no key is supplied", async () => {
    // Idempotency is opt-in: a caller that does not ask for it must not be
    // silently given different semantics.
    const operation = jest.fn().mockResolvedValue("first");

    await expect(
      service.execute("admin", undefined, PAYLOAD, operation),
    ).resolves.toBe("first");
    await expect(
      service.execute("admin", undefined, PAYLOAD, operation),
    ).resolves.toBe("first");

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("executes once and replays the stored result for a repeat", async () => {
    // The failure this prevents: a client retrying after a timeout creating a
    // second policy and spending the coverage reserve twice.
    const operation = jest
      .fn()
      .mockResolvedValueOnce({ address: "0xaaa" })
      .mockResolvedValueOnce({ address: "0xbbb" });

    const first = await service.execute("admin", "key-1", PAYLOAD, operation);
    const replay = await service.execute("admin", "key-1", PAYLOAD, operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(replay).toEqual(first);
    expect(replay).toEqual({ address: "0xaaa" });
  });

  it("rejects the same key with a different body", async () => {
    // Returning the stored result here would answer a request that was never
    // made, which is worse than refusing.
    const operation = jest.fn().mockResolvedValue("stored");
    await service.execute("admin", "key-1", PAYLOAD, operation);

    await expect(
      service.execute(
        "admin",
        "key-1",
        { ...PAYLOAD, coverageEth: "99.0" },
        operation,
      ),
    ).rejects.toThrow(ConflictException);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("treats key order in the body as irrelevant", async () => {
    const operation = jest.fn().mockResolvedValue("stored");

    await service.execute("admin", "key-1", { a: 1, b: 2 }, operation);
    await expect(
      service.execute("admin", "key-1", { b: 2, a: 1 }, operation),
    ).resolves.toBe("stored");

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("scopes keys per actor", async () => {
    // Without scoping, one caller's key would collide with another's and could
    // hand them someone else's result.
    const operation = jest
      .fn()
      .mockResolvedValueOnce("for-admin")
      .mockResolvedValueOnce("for-other");

    await expect(
      service.execute("admin", "shared-key", PAYLOAD, operation),
    ).resolves.toBe("for-admin");
    await expect(
      service.execute("other", "shared-key", PAYLOAD, operation),
    ).resolves.toBe("for-other");

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("rejects a repeat while the first is still in flight", async () => {
    let release: (value: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });

    const inFlight = service.execute("admin", "key-1", PAYLOAD, () => pending);
    // Reported rather than awaited, so a retry does not hold a second
    // connection open for the duration of a chain write.
    await expect(
      service.execute("admin", "key-1", PAYLOAD, async () => "second"),
    ).rejects.toThrow(/still in progress/);

    release("done");
    await expect(inFlight).resolves.toBe("done");
  });

  it("allows a retry after a failure", async () => {
    // The operation did not take effect, so the same key must remain usable.
    // Recording failures would strand the caller with a key that can never
    // succeed.
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new Error("chain unreachable"))
      .mockResolvedValueOnce("recovered");

    await expect(
      service.execute("admin", "key-1", PAYLOAD, operation),
    ).rejects.toThrow("chain unreachable");
    await expect(
      service.execute("admin", "key-1", PAYLOAD, operation),
    ).resolves.toBe("recovered");

    expect(operation).toHaveBeenCalledTimes(2);
  });

  describe("after a transaction has been submitted", () => {
    /** Fails the way a receipt timeout does: after the node accepted the tx. */
    const failAfterSubmitting =
      (hash: string) =>
      async (context: {
        markSubmitted: (h: { transactionHash: string }) => void;
      }) => {
        context.markSubmitted({ transactionHash: hash });
        throw new Error("not mined within the timeout");
      };

    it("does not let a retry submit a second transaction", async () => {
      // The duplicate this prevents is the expensive one: the first transaction
      // may confirm minutes later, so resubmitting can mine two policies and
      // lock the coverage reserve twice.
      const submissions: string[] = [];
      const operation = async (context: {
        markSubmitted: (h: { transactionHash: string }) => void;
      }) => {
        submissions.push("sent");
        context.markSubmitted({ transactionHash: "0xabc" });
        throw new Error("not mined within the timeout");
      };

      await expect(
        service.execute("admin", "key-1", PAYLOAD, operation),
      ).rejects.toThrow("not mined");

      await expect(
        service.execute("admin", "key-1", PAYLOAD, operation),
      ).rejects.toThrow(ConflictException);

      expect(submissions).toHaveLength(1);
    });

    it("hands the caller the hash to reconcile", async () => {
      await service
        .execute("admin", "key-1", PAYLOAD, failAfterSubmitting("0xdeadbeef"))
        .catch(() => undefined);

      await expect(
        service.execute(
          "admin",
          "key-1",
          PAYLOAD,
          failAfterSubmitting("0xnew"),
        ),
      ).rejects.toThrow(/0xdeadbeef/);
    });

    it("still surfaces the original failure to the first caller", async () => {
      // The first caller must learn its request did not complete; only the
      // retry is refused.
      await expect(
        service.execute(
          "admin",
          "key-1",
          PAYLOAD,
          failAfterSubmitting("0xabc"),
        ),
      ).rejects.toThrow("not mined within the timeout");
    });

    it("keeps the submitted record even as the completed TTL passes", async () => {
      jest.useFakeTimers();
      try {
        await service
          .execute("admin", "key-1", PAYLOAD, failAfterSubmitting("0xabc"))
          .catch(() => undefined);

        // Well within retention: the record must still block a resubmission.
        jest.advanceTimersByTime(12 * 60 * 60 * 1000);

        await expect(
          service.execute("admin", "key-1", PAYLOAD, async () => "resent"),
        ).rejects.toThrow(/already submitted/);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it("propagates the original error rather than masking it", async () => {
    const operation = jest
      .fn()
      .mockRejectedValue(new ConflictException("reserve empty"));

    await expect(
      service.execute("admin", "key-1", PAYLOAD, operation),
    ).rejects.toThrow("reserve empty");
  });

  it("never releases an in-flight record on a timer", async () => {
    // The previous behavior — and the previous test — released any in-flight
    // record after five minutes without knowing whether the operation was still
    // running, which let a retry start a second one. A clock cannot tell a slow
    // operation from an abandoned one; this store lives in the process running
    // it, so a record that is still in-flight means the work is still alive.
    jest.useFakeTimers();
    try {
      const stuck = service.execute(
        "admin",
        "key-1",
        PAYLOAD,
        () => new Promise<string>(() => undefined),
      );
      void stuck;

      jest.advanceTimersByTime(24 * 60 * 60 * 1000);

      await expect(
        service.execute("admin", "key-1", PAYLOAD, async () => "second"),
      ).rejects.toThrow(/still in progress/);
    } finally {
      jest.useRealTimers();
    }
  });

  it("expires a completed record after its retention window", async () => {
    jest.useFakeTimers();
    try {
      const operation = jest
        .fn()
        .mockResolvedValueOnce("first")
        .mockResolvedValueOnce("second");

      await service.execute("admin", "key-1", PAYLOAD, operation);
      jest.advanceTimersByTime(25 * 60 * 60 * 1000);

      await expect(
        service.execute("admin", "key-1", PAYLOAD, operation),
      ).resolves.toBe("second");
      expect(operation).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
