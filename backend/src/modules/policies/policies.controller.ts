import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type { Request } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { ApiErrorResponse } from "../../common/dto/api-error-response.dto";
import { ParseEvmAddressPipe } from "../../common/pipes/parse-evm-address.pipe";
import { CreatePolicyDto } from "./dto/create-policy.dto";
import { ListPoliciesQueryDto } from "./dto/list-policies-query.dto";
import {
  CreatePolicyResponseDto,
  PolicyListResponseDto,
  PolicyResponseDto,
} from "./dto/policy-response.dto";
import { PoliciesService } from "./policies.service";

type RequestWithId = Request & { id?: string | number };

@ApiTags("policies")
@Controller("policies")
export class PoliciesController {
  constructor(private readonly policiesService: PoliciesService) {}

  /**
   * Authenticated: unlike the read paths, creation is a state-changing
   * operation that submits a transaction signed with the backend's key and
   * draws down the provider's coverage reserve. An anonymous caller must never
   * be able to spend those. Which identities may create a policy, and on whose
   * behalf, is refined in Stage 11; requiring a valid principal is the floor.
   */
  @Post()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Create a parametric rainfall policy",
    description:
      "Submits the creation transaction on chain and returns once it is " +
      "mined. Requires an authenticated principal: creation consumes the " +
      "provider's coverage reserve. The contract assigns the insured from the " +
      "transaction sender, so the returned `insured` is the backend's signer.",
  })
  @ApiCreatedResponse({ type: CreatePolicyResponseDto })
  @ApiBadRequestResponse({
    type: ApiErrorResponse,
    description: "Payload failed validation, or the contract rejected it.",
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponse,
    description: "Missing or invalid bearer token.",
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponse,
    description:
      "Chain unreachable, no signer configured, or the coverage reserve " +
      "cannot back the policy.",
  })
  create(
    @Body() dto: CreatePolicyDto,
    @Req() request: RequestWithId,
  ): Promise<CreatePolicyResponseDto> {
    // Correlates the API request with the submitted transaction in the logs.
    const requestId = request.id !== undefined ? String(request.id) : undefined;
    return this.policiesService.create(dto, requestId);
  }

  // Reads stay public: they project state that is already world-readable on
  // chain, so gating them would add friction without adding confidentiality.
  @Public()
  @Get()
  @ApiOperation({
    summary: "List policies with pagination",
    description:
      "Reads directly from the provider's on-chain index. Pagination is " +
      "delegated to the contract; `limit` is additionally capped by " +
      "CHAIN_MAX_PAGE_SIZE to bound RPC fan-out per request.",
  })
  @ApiOkResponse({ type: PolicyListResponseDto })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponse,
    description: "Chain unreachable or not configured.",
  })
  list(@Query() query: ListPoliciesQueryDto): Promise<PolicyListResponseDto> {
    return this.policiesService.list(query);
  }

  @Public()
  @Get(":address")
  @ApiOperation({
    summary: "Get a policy by contract address",
    description:
      "Returns 404 when the provider did not create a policy at that address.",
  })
  @ApiOkResponse({ type: PolicyResponseDto })
  @ApiBadRequestResponse({
    type: ApiErrorResponse,
    description: "Address is not a valid EVM address.",
  })
  @ApiNotFoundResponse({
    type: ApiErrorResponse,
    description: "No policy created by this provider exists at that address.",
  })
  @ApiConflictResponse({
    type: ApiErrorResponse,
    description: "The contract rejected the read given current policy state.",
  })
  getByAddress(
    @Param("address", ParseEvmAddressPipe) address: string,
  ): Promise<PolicyResponseDto> {
    return this.policiesService.getByAddress(address);
  }
}
