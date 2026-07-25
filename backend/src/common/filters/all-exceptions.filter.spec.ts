import {
  ArgumentsHost,
  BadRequestException,
  HttpStatus,
  NotImplementedException,
} from "@nestjs/common";

import { AllExceptionsFilter } from "./all-exceptions.filter";
import { ApiErrorResponse } from "../dto/api-error-response.dto";

interface CapturedResponse {
  status: number;
  body: ApiErrorResponse;
}

function buildHost(
  captured: Partial<CapturedResponse>,
  request: Record<string, unknown> = {},
): ArgumentsHost {
  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: ApiErrorResponse) {
      captured.body = body;
      return this;
    },
  };

  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({
        method: "POST",
        url: "/policies",
        originalUrl: "/policies",
        id: "req-1",
        ...request,
      }),
    }),
  } as unknown as ArgumentsHost;
}

describe("AllExceptionsFilter", () => {
  const filter = new AllExceptionsFilter();

  beforeAll(() => {
    // The filter logs every handled failure; silence it for readable output.
    jest.spyOn(filter["logger"], "warn").mockImplementation(() => undefined);
    jest.spyOn(filter["logger"], "error").mockImplementation(() => undefined);
  });

  it("maps a Nest HttpException to the error contract", () => {
    const captured: Partial<CapturedResponse> = {};
    filter.catch(
      new BadRequestException(["coverageEth is invalid"]),
      buildHost(captured),
    );

    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({
      statusCode: 400,
      error: "Bad Request",
      message: ["coverageEth is invalid"],
      method: "POST",
      path: "/policies",
      requestId: "req-1",
    });
    expect(typeof captured.body?.timestamp).toBe("string");
  });

  it("preserves a deliberate 501", () => {
    const captured: Partial<CapturedResponse> = {};
    filter.catch(new NotImplementedException("Stage 06"), buildHost(captured));

    expect(captured.status).toBe(HttpStatus.NOT_IMPLEMENTED);
  });

  it("honors the status on an http-errors style middleware failure", () => {
    // body-parser raises this shape for an oversized body. Reporting it as 500
    // would blame the server for what is a client error.
    const payloadTooLarge = Object.assign(
      new Error("request entity too large"),
      {
        status: 413,
        statusCode: 413,
        type: "entity.too.large",
      },
    );

    const captured: Partial<CapturedResponse> = {};
    filter.catch(payloadTooLarge, buildHost(captured));

    expect(captured.status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(captured.body).toMatchObject({
      statusCode: 413,
      error: "Payload Too Large",
      message: "request entity too large",
    });
  });

  it("ignores a non-HTTP numeric status on an unrelated error", () => {
    // An incidental `status` field must not be mistaken for an HTTP status.
    const captured: Partial<CapturedResponse> = {};
    filter.catch(
      Object.assign(new Error("boom"), { status: 7 }),
      buildHost(captured),
    );

    expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captured.body?.message).toBe("An unexpected error occurred");
  });

  it("does not leak internals of an unexpected failure", () => {
    const captured: Partial<CapturedResponse> = {};
    filter.catch(
      new Error("connection string user:password@host"),
      buildHost(captured),
    );

    expect(captured.status).toBe(500);
    expect(captured.body?.message).toBe("An unexpected error occurred");
    expect(JSON.stringify(captured.body)).not.toContain("password");
  });

  it("falls back to url when originalUrl is absent", () => {
    const captured: Partial<CapturedResponse> = {};
    filter.catch(
      new BadRequestException("nope"),
      buildHost(captured, { originalUrl: undefined, url: "/fallback" }),
    );

    expect(captured.body?.path).toBe("/fallback");
  });

  it("omits requestId when the request carries none", () => {
    const captured: Partial<CapturedResponse> = {};
    filter.catch(
      new BadRequestException("nope"),
      buildHost(captured, { id: undefined }),
    );

    expect(captured.body?.requestId).toBeUndefined();
  });
});
