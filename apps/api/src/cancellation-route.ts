import { Router, json } from "express";
import type { SessionService } from "./services/sessions.js";
import type { OrderCancellation } from "./infrastructure/postgres-cancellation.js";
import { CancellationError } from "./services/cancellation.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess } from "./http.js";
export function createCancellationRouter(
  sessions?: SessionService,
  service?: OrderCancellation,
) {
  const router = Router(),
    attempts = new Map<string, { count: number; until: number }>();
  let inFlight = 0;
  router.post(
    "/api/v1/companies/:companyId/orders/:orderId/cancellations",
    authorize("orders.cancel", sessions),
    (req, res, next) => {
      const now = Date.now(),
        key = actorFor(req).userId;
      for (const [id, row] of attempts)
        if (row.until <= now) attempts.delete(id);
      const prior = attempts.get(key);
      if ((prior?.count ?? 0) >= 10 || (!prior && attempts.size >= 1000)) {
        res.setHeader("Retry-After", "60");
        next(
          new HttpError(
            429,
            "CANCELLATION_RATE_LIMITED",
            "Too many cancellation attempts.",
          ),
        );
        return;
      }
      attempts.set(key, {
        count: (prior?.count ?? 0) + 1,
        until: prior?.until ?? now + 60000,
      });
      if (!req.is("application/json")) {
        next(
          new HttpError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "A JSON request body is required.",
          ),
        );
        return;
      }
      next();
    },
    json({ limit: "4kb", inflate: false }),
    async (req, res, next) => {
      if (inFlight >= 4) {
        next(
          new HttpError(
            503,
            "CANCELLATION_UNAVAILABLE",
            "Cancellation could not be confirmed.",
          ),
        );
        return;
      }
      inFlight++;
      try {
        if (Object.keys(req.query).length)
          throw new CancellationError("invalid_input");
        const headers = req.rawHeaders.filter(
          (_, i) =>
            i % 2 === 0 &&
            req.rawHeaders[i]?.toLowerCase() === "idempotency-key",
        );
        if (headers.length !== 1) throw new CancellationError("invalid_input");
        if (!service) throw new CancellationError("unavailable");
        sendSuccess(
          res,
          await service(
            actorFor(req),
            req.params.companyId,
            req.params.orderId,
            req.get("Idempotency-Key"),
            req.body,
          ),
          202,
        );
      } catch (e) {
        if (e instanceof AuthorizationError || e instanceof SessionError)
          next(authorizationHttpError(e));
        else if (e instanceof CancellationError && e.code === "invalid_input")
          next(
            new HttpError(
              400,
              "INVALID_CANCELLATION_REQUEST",
              "Invalid cancellation request.",
            ),
          );
        else if (e instanceof CancellationError && e.code === "forbidden")
          next(new HttpError(403, "FORBIDDEN", "Not permitted."));
        else if (e instanceof CancellationError && e.code === "not_found")
          next(
            new HttpError(404, "CANCELLATION_NOT_FOUND", "Order not found."),
          );
        else if (e instanceof CancellationError && e.code === "conflict")
          next(
            new HttpError(
              409,
              "CANCELLATION_CONFLICT",
              "Cancellation state conflicts. Reload before another action.",
            ),
          );
        else
          next(
            new HttpError(
              503,
              "CANCELLATION_UNAVAILABLE",
              "Cancellation could not be confirmed.",
            ),
          );
      } finally {
        inFlight--;
      }
    },
  );
  return router;
}
