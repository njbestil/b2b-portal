import { Router, json } from "express";
import { ApplicationError } from "./services/applications.js";
import { HttpError, requestIdFor, sendSuccess } from "./http.js";

export type ApplicationHandler = (
  body: unknown,
  requestId: string,
) => Promise<{ state: "received"; reference: string }>;
export function createApplicationRouter(
  apply: ApplicationHandler,
  now: () => number = Date.now,
) {
  const router = Router(),
    attempts = new Map<string, { count: number; until: number }>();
  router.post(
    "/api/v1/customer-applications",
    (request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      const at = now(),
        key = request.ip ?? "unknown";
      for (const [id, row] of attempts)
        if (row.until <= at) attempts.delete(id);
      const row = attempts.get(key);
      if ((row && row.count >= 10) || (!row && attempts.size >= 1000)) {
        response.setHeader(
          "Retry-After",
          String(
            Math.max(1, Math.ceil(((row?.until ?? at + 60000) - at) / 1000)),
          ),
        );
        return next(
          new HttpError(
            429,
            "APPLICATION_RATE_LIMITED",
            "Too many application attempts. Try again later.",
          ),
        );
      }
      attempts.set(key, {
        count: (row?.count ?? 0) + 1,
        until: row?.until ?? at + 60000,
      });
      if (!request.is("application/json"))
        return next(
          new HttpError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "A JSON request body is required.",
          ),
        );
      next();
    },
    json({ limit: "16kb", inflate: false }),
    async (request, response, next) => {
      try {
        sendSuccess(
          response,
          await apply(request.body, requestIdFor(response)),
          202,
        );
      } catch (error) {
        next(
          error instanceof ApplicationError && error.code === "invalid_input"
            ? new HttpError(
                400,
                "INVALID_APPLICATION",
                "A valid business application is required.",
              )
            : new HttpError(
                503,
                "APPLICATION_UNAVAILABLE",
                "Applications are temporarily unavailable.",
              ),
        );
      }
    },
  );
  return router;
}
