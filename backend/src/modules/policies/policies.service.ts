import { Injectable, NotImplementedException } from "@nestjs/common";

import { CreatePolicyDto } from "./dto/create-policy.dto";
import { ListPoliciesQueryDto } from "./dto/list-policies-query.dto";
import {
  CreatePolicyResponseDto,
  PolicyListResponseDto,
  PolicyResponseDto,
} from "./dto/policy-response.dto";

/**
 * Orchestrates policy lifecycle requests.
 *
 * Stage 05 establishes the request/response contracts and validation. Live
 * on-chain execution (creation, reads, normalization) is wired in Stage 06 via
 * the blockchain client built from the contract registry. Until then these
 * operations fail explicitly with HTTP 501 rather than returning mock data,
 * honoring the no-runtime-mocks policy.
 */
@Injectable()
export class PoliciesService {
  private static readonly PENDING_INTEGRATION_MESSAGE =
    "Policy on-chain operations are delivered in Stage 06 (Backend to " +
    "Blockchain Integration). The request contract and validation are stable; " +
    "live execution is not yet wired.";

  async create(_dto: CreatePolicyDto): Promise<CreatePolicyResponseDto> {
    throw new NotImplementedException(
      PoliciesService.PENDING_INTEGRATION_MESSAGE,
    );
  }

  async list(_query: ListPoliciesQueryDto): Promise<PolicyListResponseDto> {
    throw new NotImplementedException(
      PoliciesService.PENDING_INTEGRATION_MESSAGE,
    );
  }

  async getByAddress(_address: string): Promise<PolicyResponseDto> {
    throw new NotImplementedException(
      PoliciesService.PENDING_INTEGRATION_MESSAGE,
    );
  }
}
