import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  Contract,
  ContractTransactionReceipt,
  Interface,
  TransactionResponse,
} from "ethers";

import { AppConfigService } from "../../config/app-config.service";
import { normalizeEvmAddress } from "../../common/utils/evm-address.util";
import {
  decodeRegionCode,
  encodeRegionCode,
} from "../../common/utils/region-code.util";
import { parseEthToWei } from "../../common/utils/eth-amount.util";
import { toHttpException } from "../blockchain/chain-error.mapper";
import { ChainProviderService } from "../blockchain/chain-provider.service";
import {
  ContractFactoryService,
  POLICY_CONTRACT,
  PROVIDER_CONTRACT,
} from "../blockchain/contract-factory.service";
import { CreatePolicyDto } from "./dto/create-policy.dto";
import {
  PolicySettlementType,
  policySettlementFromIndex,
} from "./policy-settlement.enum";
import { PolicyStatus, policyStatusFromIndex } from "./policy-status.enum";

/** Normalized on-chain view of one policy, before DTO shaping. */
export interface ChainPolicy {
  address: string;
  insured: string;
  oracle: string;
  status: PolicyStatus;
  coverageWei: string;
  premiumWei: string;
  rainfallThresholdMm: string;
  latestRainfallMm: string;
  pendingPayoutWei: string;
  conditionMet: boolean;
  paidOut: boolean;
  regionCode: string;
  region?: string;
  startTimestamp: number;
  endTimestamp: number;
  lastOracleUpdateTimestamp: number;
  settlementType: PolicySettlementType;
  settledAt?: number;
}

/** Transaction metadata returned after a successful write. */
export interface ChainWriteResult {
  address: string;
  transactionHash: string;
  blockNumber: number;
  gasUsed: string;
  effectiveGasPriceWei?: string;
  insured: string;
  status: PolicyStatus;
}

export interface PolicyPage {
  items: ChainPolicy[];
  total: number;
}

/**
 * All chain access for the policy domain.
 *
 * Reads normalize on-chain primitives into API shapes (uint256 as decimal
 * strings, enum indices as labels, `bytes32` regions as text where decodable).
 * Writes submit, wait for confirmations, and translate the receipt into
 * transaction metadata. Every failure leaves through
 * {@link toHttpException}, so no raw ethers error reaches a controller.
 */
@Injectable()
export class PolicyChainService {
  private readonly logger = new Logger(PolicyChainService.name);

  constructor(
    private readonly chain: ChainProviderService,
    private readonly contracts: ContractFactoryService,
    private readonly config: AppConfigService,
  ) {}

  /** True when an RPC endpoint is configured. */
  isEnabled(): boolean {
    return this.chain.isEnabled();
  }

  /** Interfaces used to decode reverts bubbling from either contract. */
  private get revertInterfaces(): Interface[] {
    return [
      this.contracts.getInterface(PROVIDER_CONTRACT),
      this.contracts.getInterface(POLICY_CONTRACT),
    ];
  }

  private assertEnabled(): void {
    if (!this.chain.isEnabled()) {
      throw new ServiceUnavailableException(
        "Chain integration is disabled because no RPC endpoint is configured. " +
          "Set RPC_URL to enable policy operations.",
      );
    }
  }

  // --- Reads ---------------------------------------------------------------

  /**
   * Reads one policy by address.
   *
   * The provider is asked first whether it created this address. Without that
   * check, an arbitrary address would be read as a policy and return zeroed
   * fields as if they were real data, which is worse than a clean 404.
   */
  async getPolicy(address: string): Promise<ChainPolicy | undefined> {
    this.assertEnabled();

    try {
      const provider = this.contracts.getProviderReader();
      const normalized = normalizeEvmAddress(address);

      const known = await this.chain.call(
        "isPolicyCreated",
        () => provider.isPolicyCreated(normalized) as Promise<boolean>,
      );
      if (!known) {
        return undefined;
      }

      return await this.readPolicy(normalized, provider);
    } catch (error) {
      throw toHttpException(
        error,
        this.revertInterfaces,
        `getPolicy(${address})`,
      );
    }
  }

  /**
   * Reads a page of policies, optionally filtered by insured account.
   *
   * Pagination is delegated to the contract's own paging functions rather than
   * fetching everything and slicing here: the policy list grows without bound,
   * and reading it whole would make every list request more expensive than the
   * last one.
   */
  async listPolicies(
    offset: number,
    limit: number,
    insured?: string,
  ): Promise<PolicyPage> {
    this.assertEnabled();

    const effectiveLimit = Math.min(limit, this.config.blockchain.maxPageSize);

    try {
      const provider = this.contracts.getProviderReader();

      const [addresses, total] = insured
        ? await this.chain.call(
            "getPoliciesByInsuredPage",
            () =>
              provider.getPoliciesByInsuredPage(
                normalizeEvmAddress(insured),
                offset,
                effectiveLimit,
              ) as Promise<[string[], bigint]>,
          )
        : await this.chain.call(
            "getAllPoliciesPage",
            () =>
              provider.getAllPoliciesPage(offset, effectiveLimit) as Promise<
                [string[], bigint]
              >,
          );

      // Each policy needs several calls; issuing them per policy sequentially
      // would make a 50-item page dozens of round trips deep. The page size cap
      // is what keeps this concurrency bounded.
      const items = await Promise.all(
        addresses.map((policyAddress) =>
          this.readPolicy(normalizeEvmAddress(policyAddress), provider),
        ),
      );

      return { items, total: Number(total) };
    } catch (error) {
      throw toHttpException(error, this.revertInterfaces, "listPolicies");
    }
  }

  /** Reads and normalizes a single known policy. */
  private async readPolicy(
    address: string,
    provider: Contract,
  ): Promise<ChainPolicy> {
    const policy = this.contracts.getPolicyReader(address);

    const [
      insured,
      oracle,
      statusIndex,
      coverageWei,
      premiumWei,
      rainfallThresholdMm,
      latestRainfallMm,
      pendingPayoutWei,
      conditionMet,
      regionCode,
      startTimestamp,
      endTimestamp,
      lastOracleUpdateTimestamp,
      settlement,
    ] = await Promise.all([
      this.chain.call(
        "policy.insured",
        () => policy.insured() as Promise<string>,
      ),
      this.chain.call(
        "policy.oracle",
        () => policy.oracle() as Promise<string>,
      ),
      this.chain.call(
        "policy.getStatus",
        () => policy.getStatus() as Promise<bigint>,
      ),
      this.chain.call(
        "policy.coverageWei",
        () => policy.coverageWei() as Promise<bigint>,
      ),
      this.chain.call(
        "policy.premiumWei",
        () => policy.premiumWei() as Promise<bigint>,
      ),
      this.chain.call(
        "policy.rainfallThresholdMm",
        () => policy.rainfallThresholdMm() as Promise<bigint>,
      ),
      this.chain.call(
        "policy.latestRainfallMm",
        () => policy.latestRainfallMm() as Promise<bigint>,
      ),
      this.chain.call(
        "policy.pendingPayoutWei",
        () => policy.pendingPayoutWei() as Promise<bigint>,
      ),
      this.chain.call(
        "policy.conditionMet",
        () => policy.conditionMet() as Promise<boolean>,
      ),
      this.chain.call(
        "policy.regionCode",
        () => policy.regionCode() as Promise<string>,
      ),
      this.chain.call(
        "policy.startTimestamp",
        () => policy.startTimestamp() as Promise<bigint>,
      ),
      this.chain.call(
        "policy.endTimestamp",
        () => policy.endTimestamp() as Promise<bigint>,
      ),
      this.chain.call(
        "policy.lastOracleUpdateTimestamp",
        () => policy.lastOracleUpdateTimestamp() as Promise<bigint>,
      ),
      this.chain.call(
        "provider.getPolicySettlementInfo",
        () =>
          provider.getPolicySettlementInfo(address) as Promise<
            [bigint, bigint]
          >,
      ),
    ]);

    const status = policyStatusFromIndex(Number(statusIndex));
    const settledAtRaw = Number(settlement[1]);

    return {
      address,
      insured: normalizeEvmAddress(insured),
      oracle: normalizeEvmAddress(oracle),
      status,
      coverageWei: coverageWei.toString(),
      premiumWei: premiumWei.toString(),
      rainfallThresholdMm: rainfallThresholdMm.toString(),
      latestRainfallMm: latestRainfallMm.toString(),
      pendingPayoutWei: pendingPayoutWei.toString(),
      conditionMet,
      paidOut: status === PolicyStatus.PaidOut,
      regionCode,
      region: decodeRegionCode(regionCode),
      startTimestamp: Number(startTimestamp),
      endTimestamp: Number(endTimestamp),
      lastOracleUpdateTimestamp: Number(lastOracleUpdateTimestamp),
      settlementType: policySettlementFromIndex(Number(settlement[0])),
      // Zero means unsettled rather than "settled at the epoch".
      settledAt: settledAtRaw === 0 ? undefined : settledAtRaw,
    };
  }

  // --- Writes --------------------------------------------------------------

  /**
   * Creates a policy on chain and returns its transaction metadata.
   *
   * The contract makes `msg.sender` the insured, so the policy is beneficiary-
   * bound to whoever signs. With a backend-held signer that is the backend
   * itself; the resulting insured address is returned explicitly rather than
   * being implied, so callers can see who the chain considers the beneficiary.
   *
   * A dry run precedes submission: `staticCall` executes the same transaction
   * against current state without spending gas, so a request that would revert
   * fails immediately with a decoded reason instead of costing gas and
   * surfacing as a mined-but-failed transaction.
   */
  async createPolicy(
    dto: CreatePolicyDto,
    requestId?: string,
  ): Promise<ChainWriteResult> {
    this.assertEnabled();

    if (!this.chain.hasSigner()) {
      throw new ServiceUnavailableException(
        "Policy creation requires a configured signer; set PRIVATE_KEY to " +
          "enable on-chain writes",
      );
    }

    const coverageWei = parseEthToWei(dto.coverageEth);
    const premiumWei = parseEthToWei(dto.premiumEth);

    try {
      const provider = this.contracts.getProviderWriter();
      const args = this.buildCreateArgs(dto, coverageWei);

      await this.chain.call("createPolicy.staticCall", () =>
        (
          provider[args.method].staticCall as (
            ...a: unknown[]
          ) => Promise<string>
        )(...args.params, { value: premiumWei }),
      );

      // Submission is serialized and deliberately *not* retried: a retry after
      // an ambiguous timeout could submit the same policy twice, and a
      // duplicate policy spends the reserve again. Reads are safe to retry;
      // writes are not.
      const tx: TransactionResponse = await this.chain.submitTransaction(() =>
        (
          provider[args.method] as (
            ...a: unknown[]
          ) => Promise<TransactionResponse>
        )(...args.params, { value: premiumWei }),
      );

      this.logger.log(
        `Policy creation submitted: txHash=${tx.hash} ` +
          `method=${args.method} network=${this.config.blockchain.network} ` +
          `from=${this.chain.getSignerAddress()} ` +
          `coverageWei=${coverageWei} premiumWei=${premiumWei} ` +
          `requestId=${requestId ?? "n/a"}`,
      );

      const receipt = await this.waitForReceipt(tx);
      const address = this.extractPolicyAddress(receipt);

      this.logger.log(
        `Policy creation mined: txHash=${receipt.hash} block=${receipt.blockNumber} ` +
          `gasUsed=${receipt.gasUsed} policy=${address} ` +
          `requestId=${requestId ?? "n/a"}`,
      );

      return {
        address,
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceWei: receipt.gasPrice?.toString(),
        insured: normalizeEvmAddress(this.chain.getSignerAddress() as string),
        // A freshly created policy is activated in the same transaction.
        status: PolicyStatus.Active,
      };
    } catch (error) {
      throw toHttpException(error, this.revertInterfaces, "createPolicy");
    }
  }

  /**
   * Chooses the contract entry point.
   *
   * `createPolicyWithMetadata` is the only path that honors a region and an
   * explicit start; the legacy `createPolicy` derives its own start and stores
   * `LEGACY_REGION_CODE`. The DTO already refuses a start without a region, so
   * the two branches here cover exactly the combinations that can execute.
   */
  private buildCreateArgs(
    dto: CreatePolicyDto,
    coverageWei: bigint,
  ): { method: string; params: unknown[] } {
    if (dto.region === undefined) {
      return {
        method: "createPolicy",
        params: [coverageWei, dto.rainfallThresholdMm, dto.durationDays],
      };
    }

    const requestedStart =
      dto.requestedStartTimestamp ??
      Math.floor(Date.now() / 1000) + DEFAULT_START_LEAD_SECONDS;

    return {
      method: "createPolicyWithMetadata",
      params: [
        coverageWei,
        dto.rainfallThresholdMm,
        dto.durationDays,
        encodeRegionCode(dto.region),
        requestedStart,
      ],
    };
  }

  /**
   * Waits for the transaction, bounded by the configured timeout.
   *
   * `tx.wait` alone can hang indefinitely if the transaction is never mined
   * (dropped, underpriced, or a stalled node), which would pin an HTTP request
   * open for as long as the client tolerates.
   */
  private async waitForReceipt(
    tx: TransactionResponse,
  ): Promise<ContractTransactionReceipt> {
    const { confirmations, txTimeoutMs } = this.config.blockchain;

    const receipt = await tx.wait(confirmations, txTimeoutMs);

    if (!receipt) {
      throw new ServiceUnavailableException(
        `Transaction ${tx.hash} was not mined within ${txTimeoutMs}ms. It may ` +
          `still confirm later; check the transaction hash before resubmitting.`,
      );
    }

    // status 0 means mined-but-reverted. The static call should have caught
    // this, but state can change between the dry run and inclusion.
    if (receipt.status === 0) {
      throw new ServiceUnavailableException(
        `Transaction ${tx.hash} reverted on chain at block ${receipt.blockNumber}`,
      );
    }

    return receipt as ContractTransactionReceipt;
  }

  /**
   * Extracts the created policy address from the receipt.
   *
   * Taken from the `PolicyCreated` event rather than guessing at a CREATE
   * address, so it stays correct regardless of nonce ordering or any future
   * change to how the provider deploys policies.
   */
  private extractPolicyAddress(receipt: ContractTransactionReceipt): string {
    const iface = this.contracts.getInterface(PROVIDER_CONTRACT);

    for (const log of receipt.logs) {
      const parsed = iface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (parsed?.name === "PolicyCreated") {
        return normalizeEvmAddress(String(parsed.args.policyAddress));
      }
    }

    throw new Error(
      `Transaction ${receipt.hash} mined successfully but emitted no ` +
        `PolicyCreated event; the deployed provider ABI may not match ` +
        `shared/abi/InsuranceProvider.json`,
    );
  }
}

/**
 * Lead time applied when a region is supplied without an explicit start.
 *
 * Comfortably above the contract's 60-second minimum so the transaction stays
 * valid through queueing and inclusion, matching the margin the DTO validator
 * enforces for caller-supplied starts.
 */
const DEFAULT_START_LEAD_SECONDS = 300;
