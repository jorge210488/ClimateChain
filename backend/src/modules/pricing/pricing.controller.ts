import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import {
  ApiNotImplementedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { ApiErrorResponse } from "../../common/dto/api-error-response.dto";
import { QuoteRequestDto } from "./dto/quote-request.dto";
import { QuoteResponseDto } from "./dto/quote-response.dto";
import { PricingService } from "./pricing.service";

@ApiTags("pricing")
@Controller("pricing")
export class PricingController {
  constructor(private readonly pricingService: PricingService) {}

  @Public()
  @Post("quote")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Quote a premium without creating a policy",
    description:
      "Computes a suggested premium from the ML pricing model for the given " +
      "region, coverage window, and risk parameters.",
  })
  @ApiOkResponse({ type: QuoteResponseDto })
  @ApiNotImplementedResponse({
    type: ApiErrorResponse,
    description: "Live ML pricing is wired in Stage 09.",
  })
  quote(@Body() request: QuoteRequestDto): Promise<QuoteResponseDto> {
    return this.pricingService.quote(request);
  }
}
