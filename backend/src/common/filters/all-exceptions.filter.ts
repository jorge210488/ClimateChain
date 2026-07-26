import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { ApiErrorResponse } from "../dto/api-error-response.dto";

interface NormalizedError {
  statusCode: number;
  error: string;
  message: string | string[];
}

type RequestWithId = Request & { id?: string | number };

/**
 * Labels for the statuses non-Nest middleware realistically raises, keeping the
 * `error` field machine-stable for those responses too.
 */
const HTTP_STATUS_LABELS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: "Bad Request",
  [HttpStatus.UNAUTHORIZED]: "Unauthorized",
  [HttpStatus.FORBIDDEN]: "Forbidden",
  [HttpStatus.NOT_FOUND]: "Not Found",
  [HttpStatus.NOT_ACCEPTABLE]: "Not Acceptable",
  [HttpStatus.REQUEST_TIMEOUT]: "Request Timeout",
  [HttpStatus.PAYLOAD_TOO_LARGE]: "Payload Too Large",
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: "Unsupported Media Type",
  [HttpStatus.TOO_MANY_REQUESTS]: "Too Many Requests",
  [HttpStatus.INTERNAL_SERVER_ERROR]: "Internal Server Error",
  [HttpStatus.SERVICE_UNAVAILABLE]: "Service Unavailable",
};

/**
 * Global exception filter that maps every thrown error to the canonical
 * {@link ApiErrorResponse} contract, attaches request correlation data, and
 * logs server-side failures with their stack while keeping client errors at
 * warning level.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithId>();

    const path = request.originalUrl ?? request.url;
    const requestId = request.id !== undefined ? String(request.id) : undefined;

    // Some failures carry a deliberately shaped payload rather than a message —
    // the health module signals a failed check by throwing an exception whose
    // body *is* the diagnostic report. Reshaping that into the generic contract
    // would discard exactly the information the probe exists to deliver, so
    // structured payloads are passed through untouched.
    const structured = this.extractStructuredPayload(exception);
    if (structured) {
      const status = (exception as HttpException).getStatus();
      this.logger.warn(`${request.method} ${path} -> ${status}`);
      response.status(status).json(structured);
      return;
    }

    const normalized = this.normalize(exception);

    const body: ApiErrorResponse = {
      statusCode: normalized.statusCode,
      error: normalized.error,
      message: normalized.message,
      method: request.method,
      path,
      timestamp: new Date().toISOString(),
      requestId,
    };

    // Severity follows the resolved status, not the exception's class: a 413
    // raised by body-parser is a client error and should not page anyone, while
    // a 5xx deserves a stack trace whatever type produced it.
    const logContext = `${request.method} ${path} -> ${normalized.statusCode}`;
    if (normalized.statusCode < HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.warn(logContext);
    } else if (exception instanceof HttpException) {
      // A deliberate 5xx that wraps a cause is a mapped internal failure: the
      // response is intentionally generic, so the cause is the only record of
      // what actually went wrong and must reach the logs.
      const cause = (exception as { cause?: unknown }).cause;
      if (cause instanceof Error) {
        this.logger.error(logContext, cause.stack ?? cause.message);
      } else {
        // Deliberate server-side statuses (501/503) carry no useful stack.
        this.logger.warn(logContext);
      }
    } else {
      this.logger.error(
        logContext,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(normalized.statusCode).json(body);
  }

  /**
   * Returns the payload of an exception that carries its own structured body.
   *
   * The discriminator is the absence of `message`: every Nest-standard error
   * payload has one, so an object without it was shaped deliberately by the
   * thrower and reshaping it would destroy information. Health reports are the
   * case that exists today.
   */
  private extractStructuredPayload(
    exception: unknown,
  ): Record<string, unknown> | undefined {
    if (!(exception instanceof HttpException)) {
      return undefined;
    }

    const payload = exception.getResponse();
    if (typeof payload !== "object" || payload === null) {
      return undefined;
    }

    const record = payload as Record<string, unknown>;
    return "message" in record ? undefined : record;
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === "string") {
        return { statusCode: status, error: exception.name, message: payload };
      }

      const record = payload as Record<string, unknown>;
      return {
        statusCode: status,
        error: typeof record.error === "string" ? record.error : exception.name,
        message: (record.message as string | string[]) ?? exception.message,
      };
    }

    // Middleware below Nest (body-parser, and anything else built on
    // `http-errors`) throws plain Errors carrying an HTTP status rather than
    // an HttpException. Reporting those as 500 would misattribute a client
    // error — an oversized body is a 413, not a server fault — and would hide
    // the real cause from the caller.
    const httpStatus = this.extractHttpStatus(exception);
    if (httpStatus !== undefined) {
      return {
        statusCode: httpStatus,
        error: HTTP_STATUS_LABELS[httpStatus] ?? "Error",
        message:
          exception instanceof Error ? exception.message : String(exception),
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    };
  }

  /** Reads an `http-errors`-style status off a non-Nest exception. */
  private extractHttpStatus(exception: unknown): number | undefined {
    if (typeof exception !== "object" || exception === null) {
      return undefined;
    }

    const candidate = exception as { status?: unknown; statusCode?: unknown };
    const status =
      typeof candidate.status === "number"
        ? candidate.status
        : typeof candidate.statusCode === "number"
          ? candidate.statusCode
          : undefined;

    // Only trust values in the HTTP error range; anything else is incidental
    // state on the error object rather than a deliberate status.
    return status !== undefined && status >= 400 && status <= 599
      ? status
      : undefined;
  }
}
