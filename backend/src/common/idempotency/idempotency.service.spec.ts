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

  it("propagates the original error rather than masking it", async () => {
    const operation = jest
      .fn()
      .mockRejectedValue(new ConflictException("reserve empty"));

    await expect(
      service.execute("admin", "key-1", PAYLOAD, operation),
    ).rejects.toThrow("reserve empty");
  });

  it("releases an abandoned in-flight record after its timeout", async () => {
    // An operation whose process died mid-flight must not lock the key forever.
    jest.useFakeTimers();
    try {
      const stuck = service.execute(
        "admin",
        "key-1",
        PAYLOAD,
        () => new Promise<string>(() => undefined),
      );
      void stuck;

      jest.advanceTimersByTime(6 * 60 * 1000);

      await expect(
        service.execute("admin", "key-1", PAYLOAD, async () => "retried"),
      ).resolves.toBe("retried");
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
