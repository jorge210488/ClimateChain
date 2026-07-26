import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import { JsonRpcProvider, Network, NonceManager, Wallet } from "ethers";

import { AppConfigService } from "../../config/app-config.service";
import { withRpcRetry } from "./chain-retry.util";

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
   * The network is pinned via `staticNetwork`: the chain id is already known
   * from the deployment manifest and verified at boot, so re-detecting it on
   * every call would add a round trip to each request for no benefit.
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
