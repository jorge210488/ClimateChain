import { ServiceUnavailableException } from "@nestjs/common";
import { Transaction, TransactionRequest } from "ethers";

import { AppConfigService } from "../../config/app-config.service";
import { BlockchainConfig } from "../../config/config.types";
import {
  ChainProviderService,
  SignedSubmission,
} from "./chain-provider.service";

const HARDHAT_ACCOUNT_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function buildConfig(
  overrides: Partial<BlockchainConfig> = {},
): AppConfigService {
  const blockchain: BlockchainConfig = {
    network: "localhost",
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:8545",
    privateKey: undefined,
    sharedAbiDir: "/tmp/abi",
    deploymentsDir: "/tmp/deployments",
    confirmations: 1,
    rpcTimeoutMs: 50,
    txTimeoutMs: 1_000,
    retryAttempts: 3,
    retryBaseDelayMs: 1,
    maxPageSize: 50,
    ...overrides,
  };

  return { blockchain } as AppConfigService;
}

describe("ChainProviderService", () => {
  describe("availability", () => {
    it("reports disabled when no RPC endpoint is configured", () => {
      const service = new ChainProviderService(
        buildConfig({ rpcUrl: undefined }),
      );

      expect(service.isEnabled()).toBe(false);
      expect(() => service.getProvider()).toThrow(ServiceUnavailableException);
    });

    it("reports enabled when an endpoint is configured", () => {
      expect(new ChainProviderService(buildConfig()).isEnabled()).toBe(true);
    });

    it("reports no signer when the key is absent", () => {
      const service = new ChainProviderService(buildConfig());

      expect(service.hasSigner()).toBe(false);
      expect(service.getSignerAddress()).toBeUndefined();
      // Reads work unsigned, so this must fail only when a write is attempted,
      // and the message must name the variable to set.
      expect(() => service.getSigner()).toThrow(/PRIVATE_KEY/);
    });

    it("derives the signer address from the configured key", () => {
      const service = new ChainProviderService(
        buildConfig({ privateKey: HARDHAT_ACCOUNT_0 }),
      );

      expect(service.hasSigner()).toBe(true);
      expect(service.getSignerAddress()).toBe(
        "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      );
      service.onModuleDestroy();
    });
  });

  describe("call", () => {
    it("returns the operation result", async () => {
      const service = new ChainProviderService(buildConfig());

      await expect(service.call("op", async () => 7)).resolves.toBe(7);
      service.onModuleDestroy();
    });

    it("times out a hung call and tags it as transient", async () => {
      // A hung socket would otherwise hold the HTTP request open until the
      // client gives up; the timeout converts it into a retryable failure.
      const service = new ChainProviderService(
        buildConfig({ rpcTimeoutMs: 20, retryAttempts: 1 }),
      );

      await expect(
        service.call("hung", () => new Promise(() => undefined)),
      ).rejects.toMatchObject({ code: "TIMEOUT" });

      service.onModuleDestroy();
    });

    it("retries a transient failure within one call", async () => {
      const service = new ChainProviderService(buildConfig());
      const operation = jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("reset"), { code: "ECONNRESET" }),
        )
        .mockResolvedValue("ok");

      await expect(service.call("flaky", operation)).resolves.toBe("ok");
      expect(operation).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
    });

    it("does not retry a revert", async () => {
      const service = new ChainProviderService(buildConfig());
      const operation = jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION" }),
        );

      await expect(service.call("revert", operation)).rejects.toBeDefined();
      expect(operation).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
    });

    it("clears the timeout when the operation resolves first", async () => {
      // A leaked timer would keep the event loop alive and stall shutdown.
      const service = new ChainProviderService(
        buildConfig({ rpcTimeoutMs: 60_000 }),
      );
      const before = process.getActiveResourcesInfo?.().length ?? 0;

      await service.call("fast", async () => "done");

      const after = process.getActiveResourcesInfo?.().length ?? 0;
      expect(after).toBeLessThanOrEqual(before);
      service.onModuleDestroy();
    });
  });

  describe("submitTransaction", () => {
    it("serializes concurrent submissions", async () => {
      // The defect this prevents: ethers derives the nonce per transaction, so
      // two concurrent submissions read the same value and the second is
      // rejected with NONCE_EXPIRED. Overlap here would mean that race is live.
      const service = new ChainProviderService(buildConfig());
      const events: string[] = [];

      const submit = (label: string, delayMs: number): Promise<string> =>
        service.submitTransaction(async () => {
          events.push(`start:${label}`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          events.push(`end:${label}`);
          return label;
        });

      const results = await Promise.all([
        submit("a", 30),
        submit("b", 5),
        submit("c", 1),
      ]);

      expect(results).toEqual(["a", "b", "c"]);
      // Each submission completes before the next begins, in call order.
      expect(events).toEqual([
        "start:a",
        "end:a",
        "start:b",
        "end:b",
        "start:c",
        "end:c",
      ]);
      service.onModuleDestroy();
    });

    it("keeps the queue alive after a failed submission", async () => {
      // One rejected submission must not poison every queued follow-up.
      const service = new ChainProviderService(buildConfig());

      const failed = service.submitTransaction(() =>
        Promise.reject(new Error("submission rejected")),
      );
      const next = service.submitTransaction(() => Promise.resolve("ok"));

      await expect(failed).rejects.toThrow("submission rejected");
      await expect(next).resolves.toBe("ok");
      service.onModuleDestroy();
    });

    it("resets the tracked nonce after a failed submission", async () => {
      // A local counter that advanced past a transaction which never reached
      // the mempool would fail every later send from the same account.
      const service = new ChainProviderService(
        buildConfig({ privateKey: HARDHAT_ACCOUNT_0 }),
      );
      const reset = jest.spyOn(service, "resetNonce");

      await expect(
        service.submitTransaction(() => Promise.reject(new Error("dropped"))),
      ).rejects.toThrow("dropped");

      expect(reset).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
    });

    it("leaves the nonce alone on a successful submission", async () => {
      const service = new ChainProviderService(
        buildConfig({ privateKey: HARDHAT_ACCOUNT_0 }),
      );
      const reset = jest.spyOn(service, "resetNonce");

      await service.submitTransaction(() => Promise.resolve("sent"));

      expect(reset).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it("propagates each caller's own error", async () => {
      const service = new ChainProviderService(buildConfig());

      const first = service.submitTransaction(() =>
        Promise.reject(new Error("first failed")),
      );
      const second = service.submitTransaction(() =>
        Promise.reject(new Error("second failed")),
      );

      await expect(first).rejects.toThrow("first failed");
      await expect(second).rejects.toThrow("second failed");
      service.onModuleDestroy();
    });
  });

  describe("submitSignedTransaction", () => {
    /**
     * Fully specified so signing needs no network round-trip: every field
     * `populateTransaction` would otherwise fetch is already present.
     */
    function buildRequest(nonce = 7): TransactionRequest {
      return {
        to: "0x0000000000000000000000000000000000000001",
        data: "0x",
        value: 0n,
        nonce,
        gasLimit: 21_000n,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        chainId: 31337,
        type: 2,
      };
    }

    function buildSignedService(): {
      service: ChainProviderService;
      broadcast: jest.SpyInstance;
    } {
      const service = new ChainProviderService(
        buildConfig({ privateKey: HARDHAT_ACCOUNT_0 }),
      );
      const broadcast = jest.spyOn(
        service.getProvider(),
        "broadcastTransaction",
      );
      return { service, broadcast };
    }

    it("knows the hash before the transaction reaches the network", async () => {
      // The whole point of signing separately. If the hash were learned from
      // the node's reply, a reply lost in transport would be indistinguishable
      // from a transaction that was never accepted.
      const { service, broadcast } = buildSignedService();
      const order: string[] = [];
      let broadcastRaw = "";

      broadcast.mockImplementation((raw: string) => {
        order.push("broadcast");
        broadcastRaw = raw;
        return Promise.resolve({ hash: Transaction.from(raw).hash });
      });

      let reported: SignedSubmission | undefined;
      await service.submitSignedTransaction(
        () => Promise.resolve(buildRequest()),
        (signed) => {
          order.push("signed");
          reported = signed;
        },
      );

      expect(order).toEqual(["signed", "broadcast"]);
      // Not merely "a hash was reported": the reported value must be the hash
      // of the exact bytes that were broadcast.
      expect(reported?.transactionHash).toBe(
        Transaction.from(broadcastRaw).hash,
      );
      expect(reported?.nonce).toBe(7);
      service.onModuleDestroy();
    });

    it("still reports the hash when the broadcast reply is lost", async () => {
      // The reported defect: the node may have accepted a transaction whose
      // response never came back. Callers must be able to tell that apart from
      // a clean failure, which they can only do with a hash in hand.
      const { service, broadcast } = buildSignedService();
      broadcast.mockRejectedValue(
        Object.assign(new Error("socket hang up"), { code: "NETWORK_ERROR" }),
      );

      let reported: SignedSubmission | undefined;
      await expect(
        service.submitSignedTransaction(
          () => Promise.resolve(buildRequest()),
          (signed) => {
            reported = signed;
          },
        ),
      ).rejects.toThrow("socket hang up");

      expect(reported?.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
      service.onModuleDestroy();
    });

    it("bounds a hung broadcast by the configured timeout", async () => {
      // Without this the broadcast bypassed CHAIN_RPC_TIMEOUT_MS entirely: a
      // socket the node never answers would hold this request *and* every write
      // queued behind it until ethers or the OS gave up. The submission queue
      // is serial, so one hung send stalls all of them.
      const { service, broadcast } = buildSignedService();
      broadcast.mockImplementation(() => new Promise(() => undefined));
      const reported: SignedSubmission[] = [];

      const started = Date.now();
      await expect(
        service.submitSignedTransaction(
          () => Promise.resolve(buildRequest()),
          (signed) => reported.push(signed),
        ),
      ).rejects.toMatchObject({ code: "TIMEOUT" });

      // rpcTimeoutMs is 50 in this harness; the point is that it returns at all.
      expect(Date.now() - started).toBeLessThan(5_000);
      // Timing out is the ambiguous case, so the hash must still have been
      // reported — otherwise idempotency would release the key and a retry
      // could submit a transaction the node may already hold.
      expect(reported).toHaveLength(1);
      service.onModuleDestroy();
    });

    it("does not rewind the nonce after a hung broadcast either", async () => {
      const { service, broadcast } = buildSignedService();
      broadcast.mockImplementation(() => new Promise(() => undefined));
      const reset = jest.spyOn(service, "resetNonce");

      await expect(
        service.submitSignedTransaction(
          () => Promise.resolve(buildRequest()),
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: "TIMEOUT" });

      expect(reset).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it("does not rewind the nonce after a failed broadcast", async () => {
      // Rewinding would hand the next send a nonce the node may already be
      // holding, silently replacing a policy that is on its way.
      const { service, broadcast } = buildSignedService();
      broadcast.mockRejectedValue(new Error("timeout"));
      const reset = jest.spyOn(service, "resetNonce");

      await expect(
        service.submitSignedTransaction(
          () => Promise.resolve(buildRequest()),
          () => undefined,
        ),
      ).rejects.toThrow("timeout");

      expect(reset).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it("rewinds the nonce when nothing was ever signed", async () => {
      // The opposite case: a reserved nonce that was never used blocks every
      // later send from the account.
      const { service, broadcast } = buildSignedService();
      const reset = jest.spyOn(service, "resetNonce");
      const onSigned = jest.fn();

      await expect(
        service.submitSignedTransaction(
          () => Promise.reject(new Error("could not build the call")),
          onSigned,
        ),
      ).rejects.toThrow("could not build the call");

      expect(reset).toHaveBeenCalledTimes(1);
      expect(onSigned).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it("advances the nonce across consecutive submissions", async () => {
      // Two sends must not reuse one nonce; the manager increments only once
      // the transaction is signed and committed to.
      const { service, broadcast } = buildSignedService();
      const nonces: number[] = [];
      broadcast.mockImplementation((raw: string) =>
        Promise.resolve({ hash: Transaction.from(raw).hash }),
      );

      const populate = async (): Promise<TransactionRequest> => {
        const request = buildRequest();
        delete request.nonce;
        return request;
      };
      const record = (signed: SignedSubmission): void => {
        nonces.push(signed.nonce);
      };

      jest
        .spyOn(service.getSigner(), "getNonce")
        .mockImplementation(() => Promise.resolve(nonces.length === 0 ? 4 : 5));

      await service.submitSignedTransaction(populate, record);
      await service.submitSignedTransaction(populate, record);

      expect(nonces).toEqual([4, 5]);
      service.onModuleDestroy();
    });
  });

  it("releases the provider on shutdown", () => {
    const service = new ChainProviderService(buildConfig());
    service.getProvider();

    expect(() => service.onModuleDestroy()).not.toThrow();
  });
});
