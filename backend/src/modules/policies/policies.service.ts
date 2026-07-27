import { Injectable, NotFoundException } from "@nestjs/common";

import { SubmissionHandle } from "../../common/idempotency/idempotency.service";

import { CreatePolicyDto } from "./dto/create-policy.dto";
import { ListPoliciesQueryDto } from "./dto/list-policies-query.dto";
import {
  CreatePolicyResponseDto,
  PolicyListResponseDto,
  PolicyResponseDto,
} from "./dto/policy-response.dto";
import { PolicyChainService } from "./policy-chain.service";
import { toPolicyResponse } from "./policy.mapper";

/**
 * Orchestrates policy lifecycle requests against the chain.
 *
 * Deliberately thin: validation belongs to the DTOs, chain access and error
 * translation to {@link PolicyChainService}, and wire shaping to the mapper.
 * What is left here is the decision a service should own — what "not found"
 * means, and how a page is assembled.
 */
@Injectable()
export class PoliciesService {
  constructor(private readonly chain: PolicyChainService) {}

  async create(
    dto: CreatePolicyDto,
    requestId?: string,
    onSubmitted?: (handle: SubmissionHandle) => void,
  ): Promise<CreatePolicyResponseDto> {
    const result = await this.chain.createPolicy(dto, requestId, onSubmitted);

    return {
      address: result.address,
      transactionHash: result.transactionHash,
      status: result.status,
      blockNumber: result.blockNumber,
      gasUsed: result.gasUsed,
      insured: result.insured,
    };
  }

  async list(query: ListPoliciesQueryDto): Promise<PolicyListResponseDto> {
    const { items, total, appliedLimit } = await this.chain.listPolicies(
      query.offset,
      query.limit,
      query.insured,
    );

    return {
      data: items.map(toPolicyResponse),
      meta: {
        total,
        offset: query.offset,
        // The applied limit, not the requested one: when the configured cap
        // reduces the page, a client advancing its offset by the value it asked
        // for would skip every record the cap removed.
        limit: appliedLimit,
        count: items.length,
      },
    };
  }

  async getByAddress(address: string): Promise<PolicyResponseDto> {
    const policy = await this.chain.getPolicy(address);

    // The provider does not recognize the address. Distinguishing this from a
    // read failure matters: a 404 tells the caller the address is wrong, while
    // a 5xx would suggest retrying something that can never succeed.
    if (!policy) {
      throw new NotFoundException(
        `No policy created by this provider exists at address ${address}`,
      );
    }

    return toPolicyResponse(policy);
  }
}
