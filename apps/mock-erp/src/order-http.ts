import type { ErrorRequestHandler, RequestHandler } from "express";
import { OrderError } from "./orders.js";

export const requireJson: RequestHandler = (request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  if (!request.is("application/json"))
    return next(
      new OrderError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "JSON request body required.",
      ),
    );
  next();
};

export const orderErrorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  next,
) => {
  if (response.headersSent) return next(error);
  response.setHeader("Cache-Control", "no-store");
  if (error instanceof OrderError) {
    response.status(error.statusCode).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  const type =
    typeof error === "object" && error !== null && "type" in error
      ? error.type
      : undefined;
  const description: [number, string, string] =
    type === "entity.parse.failed"
      ? [400, "INVALID_JSON", "Malformed JSON request body."]
      : type === "entity.too.large"
        ? [413, "PAYLOAD_TOO_LARGE", "Request body is too large."]
        : type === "charset.unsupported" || type === "encoding.unsupported"
          ? [
              415,
              "UNSUPPORTED_MEDIA_TYPE",
              "Unsupported request body encoding.",
            ]
          : [500, "INTERNAL_SERVER_ERROR", "Internal server error."];
  response.status(description[0]).json({
    error: { code: description[1], message: description[2] },
  });
};
