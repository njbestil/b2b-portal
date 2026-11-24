import { Router } from "express";
import type {
  IntegrationMonitorDetailResult,
  IntegrationMonitorListResult,
} from "@b2b-portal/contracts";
import {
  IntegrationMonitorError,
  type IntegrationMonitorService,
} from "./services/integration-monitor.js";
import type { SessionService } from "./services/sessions.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess } from "./http.js";
export function createIntegrationMonitorRouter(
  sessions?: SessionService,
  service?: IntegrationMonitorService,
) {
  const router = Router(),
    attempts = new Map<string, { count: number; until: number }>();
  let inFlight = 0;
  const error = (e: unknown) =>
    e instanceof AuthorizationError || e instanceof SessionError
      ? authorizationHttpError(e)
      : e instanceof IntegrationMonitorError && e.code === "invalid_input"
        ? new HttpError(
            400,
            "INVALID_INTEGRATION_MONITOR_REQUEST",
            "Invalid integration monitoring request.",
          )
        : e instanceof IntegrationMonitorError && e.code === "forbidden"
          ? new HttpError(403, "FORBIDDEN", "Not permitted.")
          : e instanceof IntegrationMonitorError && e.code === "not_found"
            ? new HttpError(
                404,
                "INTEGRATION_TRANSACTION_NOT_FOUND",
                "Integration transaction not found.",
              )
            : new HttpError(
                503,
                "INTEGRATION_MONITOR_UNAVAILABLE",
                "Integration monitoring is unavailable.",
              );
  for (const [path, detail] of [
    ["/api/v1/admin/integration-transactions", false],
    ["/api/v1/admin/integration-transactions/:id", true],
  ] as const) {
    router.get(
      path,
      authorize("integration-transactions.read", sessions),
      async (request, response, next) => {
        const time = Date.now(),
          key = actorFor(request).userId;
        for (const [id, row] of attempts)
          if (row.until <= time) attempts.delete(id);
        const attempt = attempts.get(key);
        if (
          (attempt && attempt.count >= 30) ||
          (!attempt && attempts.size >= 1000)
        ) {
          response.setHeader("Retry-After", "60");
          next(
            new HttpError(
              429,
              "INTEGRATION_MONITOR_RATE_LIMITED",
              "Too many integration monitoring requests.",
            ),
          );
          return;
        }
        attempts.set(key, {
          count: (attempt?.count ?? 0) + 1,
          until: attempt?.until ?? time + 60000,
        });
        if (inFlight >= 4) {
          next(error(new IntegrationMonitorError("unavailable")));
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
          if (!service) throw new IntegrationMonitorError("unavailable");
          if (detail) {
            if (Object.keys(request.query).length)
              throw new IntegrationMonitorError("invalid_input");
            const result: IntegrationMonitorDetailResult = await service.find(
              actorFor(request),
              request.params.id,
              controller.signal,
            );
            sendSuccess(response, result);
          } else {
            const result: IntegrationMonitorListResult = await service.list(
              actorFor(request),
              request.query,
              controller.signal,
            );
            sendSuccess(response, result);
          }
        } catch (e) {
          next(error(e));
        } finally {
          inFlight--;
          request.off("aborted", abort);
          response.off("close", abort);
        }
      },
    );
  }
  return router;
}
