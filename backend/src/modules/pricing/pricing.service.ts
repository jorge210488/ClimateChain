import { Injectable, NotImplementedException } from "@nestjs/common";

import { QuoteRequestDto } from "./dto/quote-request.dto";
import { QuoteResponseDto } from "./dto/quote-response.dto";

/**
 * Produces premium quotes.
 *
 * Stage 05 establishes the request/response contract and validation. The live
 * call to the Python ML pricing service is wired in Stage 09; until then this
 * operation fails explicitly with HTTP 501 instead of returning mock pricing,
 * honoring the no-runtime-mocks policy.
 */
@Injectable()
export class PricingService {
  private static readonly PENDING_INTEGRATION_MESSAGE =
    "Premium quoting is delivered in Stage 09 (Backend to ML Integration). " +
    "The request contract and validation are stable; the live ML call is not " +
    "yet wired.";

  async quote(_request: QuoteRequestDto): Promise<QuoteResponseDto> {
    throw new NotImplementedException(
      PricingService.PENDING_INTEGRATION_MESSAGE,
    );
  }
}
