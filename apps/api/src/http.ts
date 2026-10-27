import type { ApiFailure, ApiSuccess } from "@b2b-portal/contracts";
import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler, Response } from "express";

function requestIdFor(response: Response): string {
  const existing: unknown = response.locals.requestId;
  if (typeof existing === "string") {
    return existing;
  }
  const requestId = randomUUID();
  response.locals.requestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  return requestId;
}

export const requestIdMiddleware: RequestHandler = (
  _request,
  response,
  next,
) => {
  requestIdFor(response);
  next();
};

export function sendSuccess<T>(
  response: Response,
  data: T,
  statusCode = 200,
): void {
  const body: ApiSuccess<T> = {
    success: true,
    data,
    requestId: requestIdFor(response),
  };
  response.status(statusCode).json(body);
}

// Only explicitly public messages belong here; never pass raw internal errors.
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    publicMessage: string,
  ) {
    super(publicMessage);
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
      throw new RangeError("HttpError statusCode must be between 400 and 599");
    }
    this.name = "HttpError";
  }
}

interface ErrorDescription {
  statusCode: number;
  code: string;
  message: string;
}

function describeError(error: unknown): ErrorDescription {
  if (error instanceof HttpError) {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const type = "type" in error ? error.type : undefined;
    switch (type) {
      case "entity.parse.failed":
        return {
          statusCode: 400,
          code: "INVALID_JSON",
          message: "Malformed JSON request body.",
        };
      case "entity.too.large":
        return {
          statusCode: 413,
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body is too large.",
        };
      case "charset.unsupported":
      case "encoding.unsupported":
        return {
          statusCode: 415,
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "Unsupported request body encoding.",
        };
    }

    const status = "status" in error ? error.status : undefined;
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 400 &&
      status < 500
    ) {
      return {
        statusCode: status,
        code: "REQUEST_ERROR",
        message: "The request could not be processed.",
      };
    }
  }

  return {
    statusCode: 500,
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal server error.",
  };
}

export const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new HttpError(404, "NOT_FOUND", "Route not found."));
};

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  next,
) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  const { statusCode, code, message } = describeError(error);
  const body: ApiFailure = {
    success: false,
    error: { code, message },
    requestId: requestIdFor(response),
  };
  response.status(statusCode).json(body);
};
