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

    const normalized = this.normalize(exception);
    const path = request.originalUrl ?? request.url;
    const requestId = request.id !== undefined ? String(request.id) : undefined;

    const body: ApiErrorResponse = {
      statusCode: normalized.statusCode,
      error: normalized.error,
      message: normalized.message,
      method: request.method,
      path,
      timestamp: new Date().toISOString(),
      requestId,
    };

    // Controlled API errors (HttpException, including deliberate 501/503) log at
    // warn; only unexpected failures log at error with a stack trace.
    const logContext = `${request.method} ${path} -> ${normalized.statusCode}`;
    if (exception instanceof HttpException) {
      this.logger.warn(logContext);
    } else {
      this.logger.error(
        logContext,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(normalized.statusCode).json(body);
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

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    };
  }
}
