import { isTransientRpcError, withRpcRetry } from "./chain-retry.util";

function errorWith(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`failed with ${code}`), { code, ...extra });
}

describe("isTransientRpcError", () => {
  it.each(["NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT", "UNKNOWN_ERROR"])(
    "treats ethers %s as transient",
    (code) => {
      expect(isTransientRpcError(errorWith(code))).toBe(true);
    },
  );

  it.each(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"])(
    "treats socket failure %s as transient",
    (code) => {
      expect(isTransientRpcError(errorWith(code))).toBe(true);
    },
  );

  it("unwraps a socket failure carried as a cause", () => {
    const wrapped = Object.assign(new Error("fetch failed"), {
      cause: errorWith("ECONNREFUSED"),
    });
    expect(isTransientRpcError(wrapped)).toBe(true);
  });

  it("never retries a revert", () => {
    // The decisive case: CALL_EXCEPTION is deterministic, so retrying it only
    // multiplies latency on a request that is already failing.
    expect(isTransientRpcError(errorWith("CALL_EXCEPTION"))).toBe(false);
  });

  it.each([
    "INSUFFICIENT_FUNDS",
    "NONCE_EXPIRED",
    "REPLACEMENT_UNDERPRICED",
    "INVALID_ARGUMENT",
    "ACTION_REJECTED",
  ])("never retries %s", (code) => {
    expect(isTransientRpcError(errorWith(code))).toBe(false);
  });

  it("defaults an unrecognized code to non-transient", () => {
    // Fail closed: a new ethers code must not become a retry storm by default.
    expect(isTransientRpcError(errorWith("SOME_FUTURE_CODE"))).toBe(false);
  });

  it.each([undefined, null, "a string", 42, {}, new Error("plain")])(
    "handles non-coded input %p",
    (value) => {
      expect(isTransientRpcError(value)).toBe(false);
    },
  );
});

describe("withRpcRetry", () => {
  const noSleep = async (): Promise<void> => undefined;
  const fixedRandom = (): number => 0.5;

  it("returns the value without retrying on success", async () => {
    const operation = jest.fn().mockResolvedValue("ok");

    await expect(
      withRpcRetry(operation, { attempts: 3, baseDelayMs: 10, sleep: noSleep }),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and succeeds", async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(errorWith("NETWORK_ERROR"))
      .mockResolvedValue("recovered");

    await expect(
      withRpcRetry(operation, { attempts: 3, baseDelayMs: 10, sleep: noSleep }),
    ).resolves.toBe("recovered");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry a revert", async () => {
    const operation = jest.fn().mockRejectedValue(errorWith("CALL_EXCEPTION"));

    await expect(
      withRpcRetry(operation, { attempts: 5, baseDelayMs: 10, sleep: noSleep }),
    ).rejects.toMatchObject({ code: "CALL_EXCEPTION" });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured attempts and rethrows the last error", async () => {
    const operation = jest.fn().mockRejectedValue(errorWith("TIMEOUT"));

    await expect(
      withRpcRetry(operation, { attempts: 3, baseDelayMs: 10, sleep: noSleep }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("backs off exponentially", async () => {
    const delays: number[] = [];
    const operation = jest.fn().mockRejectedValue(errorWith("SERVER_ERROR"));

    await expect(
      withRpcRetry(operation, {
        attempts: 4,
        baseDelayMs: 100,
        random: fixedRandom,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toBeDefined();

    // With random fixed at 0.5 the jitter factor is 0.75: 75, 150, 300.
    expect(delays).toEqual([75, 150, 300]);
  });

  it("jitters the delay so concurrent retries do not align", async () => {
    // Without jitter, every caller failing at the same instant would retry at
    // the same instant and hit the recovering node as one synchronized burst.
    const collect = async (random: () => number): Promise<number[]> => {
      const delays: number[] = [];
      await withRpcRetry(jest.fn().mockRejectedValue(errorWith("TIMEOUT")), {
        attempts: 2,
        baseDelayMs: 100,
        random,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }).catch(() => undefined);
      return delays;
    };

    expect(await collect(() => 0)).toEqual([50]);
    expect(await collect(() => 1)).toEqual([100]);
  });

  it("reports each retry with its attempt number and delay", async () => {
    const onRetry = jest.fn();
    await withRpcRetry(
      jest
        .fn()
        .mockRejectedValueOnce(errorWith("NETWORK_ERROR"))
        .mockResolvedValue("ok"),
      { attempts: 3, baseDelayMs: 10, sleep: noSleep, onRetry },
    );

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      expect.any(Error),
    );
  });
});
