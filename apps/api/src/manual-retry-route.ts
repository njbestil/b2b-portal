import { Router, json } from "express";
import type { SessionService } from "./services/sessions.js";
import type { ManualRetry } from "./infrastructure/postgres-manual-retry.js";
import { ManualRetryError } from "./services/manual-retry.js";
import { IntegrationMonitorError } from "./services/integration-monitor.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess } from "./http.js";
export function createManualRetryRouter(
  sessions?: SessionService,
  retry?: ManualRetry,
) {
  const router = Router(),
    attempts = new Map<string, { count: number; until: number }>();
  let inFlight = 0;
  router.post(
    "/api/v1/admin/integration-transactions/:id/retry",
    authorize("integration-transactions.retry", sessions),
    (request, response, next) => {
      const time = Date.now(),
        actor = actorFor(request);
      for (const [id, row] of attempts)
        if (row.until <= time) attempts.delete(id);
      const row = attempts.get(actor.userId);
      if ((row && row.count >= 5) || (!row && attempts.size >= 1000)) {
        response.setHeader("Retry-After", "60");
        next(
          new HttpError(
            429,
            "MANUAL_RETRY_RATE_LIMITED",
            "Too many retry requests.",
          ),
        );
        return;
      }
      attempts.set(actor.userId, {
        count: (row?.count ?? 0) + 1,
        until: row?.until ?? time + 60000,
      });
      if (!request.is("application/json")) {
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
    json({ limit: "2kb", inflate: false }),
    async (request, response, next) => {
      if (inFlight >= 2) {
        next(
          new HttpError(
            503,
            "MANUAL_RETRY_UNAVAILABLE",
            "Manual retry is unavailable.",
          ),
        );
        return;
      }
      inFlight++;
      const controller = new AbortController(),
        abort = () => {
          if (!response.writableEnded) controller.abort();
        };
      request.once("aborted", abort);
      response.once("close", abort);
      try {
        if (!retry) throw new ManualRetryError("unavailable");
        if (Object.keys(request.query).length)
          throw new ManualRetryError("invalid_input");
        sendSuccess(
          response,
          await retry(
            actorFor(request),
            request.params.id,
            request.body,
            controller.signal,
          ),
          202,
        );
      } catch (e) {
        if (e instanceof SessionError || e instanceof AuthorizationError)
          next(authorizationHttpError(e));
        else if (e instanceof IntegrationMonitorError && e.code === "forbidden")
          next(new HttpError(403, "FORBIDDEN", "Not permitted."));
        else if (
          (e instanceof ManualRetryError && e.code === "invalid_input") ||
          (e instanceof IntegrationMonitorError && e.code === "invalid_input")
        )
          next(
            new HttpError(
              400,
              "INVALID_MANUAL_RETRY_REQUEST",
              "Invalid manual retry request.",
            ),
          );
        else if (e instanceof ManualRetryError && e.code === "not_found")
          next(
            new HttpError(
              404,
              "INTEGRATION_TRANSACTION_NOT_FOUND",
              "Integration transaction not found.",
            ),
          );
        else if (e instanceof ManualRetryError && e.code === "conflict")
          next(
            new HttpError(
              409,
              "MANUAL_RETRY_CONFLICT",
              "This transaction cannot be retried. Reload its current state.",
            ),
          );
        else
          next(
            new HttpError(
              503,
              "MANUAL_RETRY_UNAVAILABLE",
              "Manual retry could not be confirmed. Check its current state before another action.",
            ),
          );
      } finally {
        inFlight--;
        request.off("aborted", abort);
        response.off("close", abort);
      }
    },
  );
  return router;
}
