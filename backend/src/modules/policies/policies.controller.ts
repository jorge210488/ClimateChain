import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle, ThrottlerGuard } from "@nestjs/throttler";

import { AUTH_THROTTLER } from "../../common/throttling/throttling.module";
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
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
import { IdempotencyService } from "../../common/idempotency/idempotency.service";
import { ParseEvmAddressPipe } from "../../common/pipes/parse-evm-address.pipe";
import { CreatePolicyDto } from "./dto/create-policy.dto";
import { ListPoliciesQueryDto } from "./dto/list-policies-query.dto";
import {
  CreatePolicyResponseDto,
  PolicyListResponseDto,
  PolicyResponseDto,
} from "./dto/policy-response.dto";
import { PoliciesService } from "./policies.service";

type RequestWithId = Request & {
  id?: string | number;
  user?: { userId?: string };
};

@ApiTags("policies")
@Controller("policies")
// Applied at controller level: every route here reaches the chain, and the
// read routes are anonymous, so each request a caller sends becomes many
// requests the RPC endpoint has to answer and bill for. Only the policy budget
// applies; the auth limiter guards a different resource.
@UseGuards(ThrottlerGuard)
@SkipThrottle({ [AUTH_THROTTLER]: true })
export class PoliciesController {
  constructor(
    private readonly policiesService: PoliciesService,
    private readonly idempotency: IdempotencyService,
  ) {}

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
  @ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description:
      "Opt-in replay protection. A repeat with the same key returns the " +
      "original result instead of creating a second policy. Reusing a key with " +
      "a different body is rejected with 409. The store is in-process and " +
      "non-durable: it covers a client retry, not a restart or a second instance.",
  })
  @ApiCreatedResponse({ type: CreatePolicyResponseDto })
  @ApiBadRequestResponse({
    type: ApiErrorResponse,
    description: "Payload failed validation, or the contract rejected it.",
  })
  @ApiConflictResponse({
    type: ApiErrorResponse,
    description:
      "The Idempotency-Key is in flight, or was already used with a different body.",
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
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<CreatePolicyResponseDto> {
    // Correlates the API request with the submitted transaction in the logs.
    const requestId = request.id !== undefined ? String(request.id) : undefined;

    // Scoped to the authenticated principal so one caller's key cannot collide
    // with another's.
    const actor = request.user?.userId ?? "anonymous";

    return this.idempotency.execute(actor, idempotencyKey, dto, () =>
      this.policiesService.create(dto, requestId),
    );
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
