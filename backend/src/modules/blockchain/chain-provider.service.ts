import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  JsonRpcProvider,
  Network,
  NonceManager,
  Transaction,
  TransactionRequest,
  TransactionResponse,
  Wallet,
} from "ethers";

import { AppConfigService } from "../../config/app-config.service";
import { withRpcRetry } from "./chain-retry.util";

/** A transaction that has been signed but not necessarily broadcast. */
export interface SignedSubmission {
  /** Hash derived from the signed payload, valid before it reaches any node. */
  transactionHash: string;
  /** Nonce reserved for it on the signing account. */
  nonce: number;
}

/**
 * Owns the JSON-RPC connection and the optional signer.
 *
 * Everything that talks to the chain goes through {@link call}, so retry policy,
 * timeouts, and failure translation live in one place instead of being
 * re-implemented per call site.
 */
@Injectable()
export class ChainProviderService implements OnModuleDestroy {
  private readonly logger = new Logger(ChainProviderService.name);
  private provider?: JsonRpcProvider;
  private wallet?: Wallet;
  private signer?: NonceManager;

  constructor(private readonly config: AppConfigService) {}

  /** True when an RPC endpoint is configured and the client is usable. */
  isEnabled(): boolean {
    return Boolean(this.config.blockchain.rpcUrl);
  }

  /** True when a signer is configured, which is what write paths require. */
  hasSigner(): boolean {
    return Boolean(this.config.blockchain.privateKey);
  }

  /**
   * Returns the shared provider, creating it on first use.
   *
   * `staticNetwork` avoids re-detecting the network on every call, which would
   * add a round trip per request. The trade-off is that `getNetwork()` then
   * reports the configured value without contacting the node, so it must never
   * be used to *verify* anything — see {@link getChainIdFromNode}, which boot
   * verification and the readiness probe both go through instead.
   */
  getProvider(): JsonRpcProvider {
    if (this.provider) {
      return this.provider;
    }

    const { rpcUrl, chainId, network } = this.config.blockchain;
    if (!rpcUrl) {
      throw new ServiceUnavailableException(
        "No RPC endpoint is configured; set RPC_URL to enable chain access",
      );
    }

    this.provider = new JsonRpcProvider(
      rpcUrl,
      chainId !== undefined ? Network.from(chainId) : undefined,
      {
        staticNetwork: chainId !== undefined,
        pollingInterval: 1_000,
      },
    );

    this.logger.log(
      `Chain provider initialized: network=${network} ` +
        `chainId=${chainId ?? "auto-detected"}`,
    );

    return this.provider;
  }

  /**
   * Returns the signer used for write paths.
   *
   * Absence is a configuration state, not a bug: reads work fine without a
   * signer, so this fails only when a write is actually attempted, and with a
   * message naming the missing variable.
   *
   * The wallet is wrapped in a `NonceManager`, which assigns nonces locally
   * instead of asking the node for each transaction. Querying the node is
   * unreliable here: the pending count can lag a transaction the node has
   * already accepted, and the next send then reuses a spent nonce and is
   * rejected. Tracking locally makes the sequence authoritative on our side.
   *
   * This assumes the account sends only through this process — the same
   * constraint the submission queue documents.
   */
  getSigner(): NonceManager {
    if (this.signer) {
      return this.signer;
    }

    const privateKey = this.config.blockchain.privateKey;
    if (!privateKey) {
      throw new ServiceUnavailableException(
        "No signer is configured; set PRIVATE_KEY to enable on-chain writes",
      );
    }

    this.wallet = new Wallet(privateKey, this.getProvider());
    this.signer = new NonceManager(this.wallet);
    return this.signer;
  }

  /**
   * Chain id reported by the node itself, as a decimal string.
   *
   * Deliberately a raw `eth_chainId` request rather than `provider.getNetwork()`:
   * the provider is created with `staticNetwork` when `CHAIN_ID` is configured,
   * and `getNetwork()` then returns that configured value **without contacting
   * the node**. Comparing it against configuration would compare configuration
   * with itself and pass against any chain.
   */
  async getChainIdFromNode(): Promise<string> {
    const raw = await this.call(
      "eth_chainId",
      () => this.getProvider().send("eth_chainId", []) as Promise<string>,
    );

    // Nodes answer with a hex quantity; BigInt parses it without precision loss.
    return BigInt(raw).toString();
  }

  /**
   * Current head block number, asked of the node.
   *
   * A raw request rather than `provider.getBlockNumber()`, which answers from a
   * cache refreshed on the polling interval and can therefore be a block or two
   * behind. That matters when the number is used to pin reads: a stale pin makes
   * a read that follows a write observe the state *before* it, so a policy
   * created a moment earlier reads as not existing.
   */
  async getBlockNumberFromNode(): Promise<number> {
    const raw = await this.call(
      "eth_blockNumber",
      () => this.getProvider().send("eth_blockNumber", []) as Promise<string>,
    );

    return Number(BigInt(raw));
  }

  /**
   * Timestamp the node will stamp on the next block it mines.
   *
   * This is the value the contract compares a requested policy start against,
   * so it is the only clock worth deriving a default start from. Neither
   * obvious alternative works:
   *
   * - The `latest` block is the *previous* one, and it ages while the chain is
   *   idle — a node mines only when there is work. Measured 604 seconds behind
   *   the block that was actually mined next, on a quiet node, against 0 for
   *   `pending`.
   * - Server time is unrelated to a chain whose clock has drifted or been
   *   advanced.
   *
   * Falls back to `latest` and then to server time, taking whichever is later,
   * because a node that does not serve a pending block leaves no better
   * estimate and underestimating is what causes the revert.
   */
  async getNextBlockTimestamp(): Promise<number> {
    const serverNow = Math.floor(Date.now() / 1000);

    const readBlockTimestamp = async (
      tag: "pending" | "latest",
    ): Promise<number | undefined> => {
      const block = (await this.call(`eth_getBlockByNumber(${tag})`, () =>
        this.getProvider().send("eth_getBlockByNumber", [tag, false]),
      )) as { timestamp?: string } | null;

      return block?.timestamp === undefined
        ? undefined
        : Number(BigInt(block.timestamp));
    };

    try {
      const pending = await readBlockTimestamp("pending");
      if (pending !== undefined) {
        return pending;
      }

      const latest = await readBlockTimestamp("latest");
      return latest === undefined ? serverNow : Math.max(latest, serverNow);
    } catch {
      // A transient failure must not reject a request the contract would
      // accept; server time is the best remaining approximation.
      return serverNow;
    }
  }

  /** Address transactions are sent from, or undefined when unsigned. */
  getSignerAddress(): string | undefined {
    if (!this.hasSigner()) {
      return undefined;
    }
    // Read from the underlying wallet: NonceManager resolves its address
    // asynchronously, while the wallet exposes it synchronously.
    this.getSigner();
    return this.wallet?.address;
  }

  /**
   * Discards the locally tracked nonce so the next send re-reads it from the
   * node. Used after a submission failure, where the local counter may have
   * advanced past a transaction that never entered the mempool.
   */
  resetNonce(): void {
    this.signer?.reset();
  }

  /**
   * Runs an RPC operation under the configured retry policy and timeout.
   *
   * `label` is carried into logs so a retry storm can be attributed to a
   * specific call rather than appearing as anonymous network noise.
   */
  async call<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const { retryAttempts, retryBaseDelayMs, rpcTimeoutMs } =
      this.config.blockchain;

    return withRpcRetry(
      () => this.withTimeout(label, operation, rpcTimeoutMs),
      {
        attempts: retryAttempts,
        baseDelayMs: retryBaseDelayMs,
        onRetry: (attempt, delayMs, error) => {
          this.logger.warn(
            `Transient RPC failure on ${label} (attempt ${attempt}/${retryAttempts}); ` +
              `retrying in ${delayMs}ms: ${describe(error)}`,
          );
        },
      },
    );
  }

  /**
   * Fails an operation that outlives `timeoutMs`.
   *
   * A hung socket otherwise holds the HTTP request open until the client gives
   * up, so the timeout is what converts an unresponsive node into a prompt,
   * retryable failure.
   */
  private async withTimeout<T>(
    label: string,
    operation: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              Object.assign(
                new Error(`RPC call ${label} timed out after ${timeoutMs}ms`),
                // Tagged as TIMEOUT so the retry policy treats it as transient.
                { code: "TIMEOUT" },
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Serializes transaction submission for the shared signer.
   *
   * Every transaction from one account must carry the next sequential nonce.
   * ethers derives that nonce per transaction, so two concurrent submissions
   * read the same value and the second is rejected with NONCE_EXPIRED — a
   * failure that looks random and is trivially reachable with two simultaneous
   * requests. Queuing submissions behind a single promise chain makes the
   * ordering deterministic.
   *
   * The queue holds only submission, not confirmation waiting: releasing after
   * the node accepts the transaction is enough for the nonce to advance, and
   * holding it through confirmation would serialize unrelated requests behind
   * block times.
   *
   * Scope is this process. Running several instances against one signer
   * reintroduces the race and needs external nonce coordination or a signer per
   * instance; see the Stage 06 report.
   */
  async submitTransaction<T>(send: () => Promise<T>): Promise<T> {
    const attempt = async (): Promise<T> => {
      try {
        return await send();
      } catch (error) {
        // The local nonce may have advanced past a transaction that never
        // reached the mempool; leaving it advanced would fail every later
        // send with the same account.
        this.resetNonce();
        throw error;
      }
    };

    return this.enqueue(attempt);
  }

  /**
   * Submits a transaction whose hash is known *before* it is broadcast.
   *
   * `submitTransaction` leaves one window open. `sendTransaction` signs and
   * broadcasts in a single step, so the hash arrives with the node's response —
   * and if that response is lost in transport, the caller sees a plain failure
   * for a transaction the node may already have accepted. Treating that as "no
   * effect" is what lets a retry create a second policy and lock the reserve
   * twice.
   *
   * Splitting the step removes the ambiguity: the transaction is signed
   * locally, which determines its hash, and `onSigned` fires before anything
   * touches the network. From that point a failure is *ambiguous rather than
   * clean*, and the caller can say so with a concrete hash to reconcile
   * against, instead of guessing.
   *
   * The nonce is reserved on the same path. It is only released back — via
   * `resetNonce` — when the transaction was never handed over, because a
   * reserved-but-unused nonce blocks every later send from this account.
   *
   * @param populate Builds the unsigned request (typically from a contract
   *   method's `populateTransaction`).
   * @param onSigned Receives the hash and nonce once signed, before broadcast.
   */
  async submitSignedTransaction(
    populate: () => Promise<TransactionRequest>,
    onSigned: (signed: SignedSubmission) => void,
  ): Promise<TransactionResponse> {
    const attempt = async (): Promise<TransactionResponse> => {
      const signer = this.getSigner();
      const wallet = this.wallet;
      if (!wallet) {
        throw new ServiceUnavailableException(
          "No signer is configured; set PRIVATE_KEY to enable on-chain writes",
        );
      }

      let raw: string;
      let nonce: number;
      try {
        const request = await populate();
        // Populating through the NonceManager is what assigns the managed
        // nonce; signing goes to the wallet underneath, which is the only one
        // that holds the key.
        const prepared = await signer.populateTransaction(request);
        raw = await wallet.signTransaction(prepared);
        nonce = Number(prepared.nonce);
      } catch (error) {
        // Nothing was signed, so nothing can be in flight.
        this.resetNonce();
        throw error;
      }

      const transactionHash = Transaction.from(raw).hash;
      if (!transactionHash) {
        // Unreachable for a signed transaction, but the type is nullable and a
        // silent undefined here would defeat the whole point of this method.
        this.resetNonce();
        throw new ServiceUnavailableException(
          "Could not derive a transaction hash before broadcasting",
        );
      }

      // The point of no return, moved to where it belongs: from here on the
      // transaction exists and may be mined, whatever the network reports.
      onSigned({ transactionHash, nonce });
      signer.increment();

      try {
        // Timed out, never retried. Retrying would resubmit a transaction the
        // node may already hold; leaving it untimed would let one hung socket
        // block this request *and* every write queued behind it until ethers or
        // the OS gave up, ignoring the configured budget entirely. A timeout
        // here is the ambiguous case, not a clean failure — which is why the
        // hash was reported before the call and the nonce is left alone.
        return await this.withTimeout(
          "broadcastTransaction",
          () => this.getProvider().broadcastTransaction(raw),
          this.config.blockchain.rpcTimeoutMs,
        );
      } catch (error) {
        // Deliberately *not* resetting the nonce: the node may hold this
        // transaction. Rewinding would make the next send reuse a live nonce
        // and replace a policy that is already on its way.
        this.logger.error(
          `Broadcast failed for ${transactionHash} (nonce ${nonce}); it may ` +
            `still be mined. Reconcile against the hash before resubmitting: ` +
            `${describe(error)}`,
        );
        throw error;
      }
    };

    return this.enqueue(attempt);
  }

  /** Runs one submission at a time, in call order. */
  private enqueue<T>(attempt: () => Promise<T>): Promise<T> {
    const run = this.submissionQueue.then(attempt, attempt);
    // Swallow rejection on the chain itself so one failed submission does not
    // reject every queued follow-up; the caller still receives its own error.
    this.submissionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private submissionQueue: Promise<unknown> = Promise.resolve();

  /** Releases the socket so the process can exit cleanly on shutdown. */
  onModuleDestroy(): void {
    this.provider?.destroy();
    this.provider = undefined;
    this.wallet = undefined;
    this.signer = undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
