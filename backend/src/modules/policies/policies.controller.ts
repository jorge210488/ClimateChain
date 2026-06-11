import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiNotImplementedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
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

  @Public()
  @Post()
  @ApiOperation({ summary: "Create a parametric rainfall policy" })
  @ApiCreatedResponse({ type: CreatePolicyResponseDto })
  @ApiNotImplementedResponse({
    type: ApiErrorResponse,
    description: "Live on-chain execution is wired in Stage 06.",
  })
  create(@Body() dto: CreatePolicyDto): Promise<CreatePolicyResponseDto> {
    return this.policiesService.create(dto);
  }

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
