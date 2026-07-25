import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotImplementedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

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

@ApiTags("policies")
@Controller("policies")
export class PoliciesController {
  constructor(private readonly policiesService: PoliciesService) {}

  /**
   * Authenticated: unlike the read paths, creation is a state-changing
   * operation that will, from Stage 06, submit a transaction signed with the
   * backend's key and draw down the provider's coverage reserve. An anonymous
   * caller must never be able to spend those. Which identities may create a
   * policy, and on whose behalf, is refined in Stage 06 (chain integration) and
   * Stage 11 (user persistence); requiring a valid principal is the floor.
   */
  @Post()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Create a parametric rainfall policy",
    description:
      "Requires an authenticated principal: creation consumes the provider's " +
      "coverage reserve and is submitted on-chain from Stage 06 onward.",
  })
  @ApiCreatedResponse({ type: CreatePolicyResponseDto })
  @ApiUnauthorizedResponse({
    type: ApiErrorResponse,
    description: "Missing or invalid bearer token.",
  })
  @ApiNotImplementedResponse({
    type: ApiErrorResponse,
    description: "Live on-chain execution is wired in Stage 06.",
  })
  create(@Body() dto: CreatePolicyDto): Promise<CreatePolicyResponseDto> {
    return this.policiesService.create(dto);
  }

  // Reads stay public: they project state that is already world-readable on
  // chain, so gating them would add friction without adding confidentiality.
  @Public()
  @Get()
  @ApiOperation({ summary: "List policies with pagination" })
  @ApiOkResponse({ type: PolicyListResponseDto })
  @ApiNotImplementedResponse({
    type: ApiErrorResponse,
    description: "Live on-chain reads are wired in Stage 06.",
  })
  list(@Query() query: ListPoliciesQueryDto): Promise<PolicyListResponseDto> {
    return this.policiesService.list(query);
  }

  @Public()
  @Get(":address")
  @ApiOperation({ summary: "Get a policy by contract address" })
  @ApiOkResponse({ type: PolicyResponseDto })
  @ApiNotImplementedResponse({
    type: ApiErrorResponse,
    description: "Live on-chain reads are wired in Stage 06.",
  })
  getByAddress(
    @Param("address", ParseEvmAddressPipe) address: string,
  ): Promise<PolicyResponseDto> {
    return this.policiesService.getByAddress(address);
  }
}
