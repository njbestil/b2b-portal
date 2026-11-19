import { Router, json, type RequestHandler } from "express";
import type { FulfillmentResult } from "@b2b-portal/contracts";
import {
  FulfillmentError,
  type FulfillmentService,
} from "./services/fulfillment.js";
import type { SessionService } from "./services/sessions.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, requestIdFor, sendSuccess } from "./http.js";
export function createFulfillmentRouter(
  sessions?: SessionService,
  service?: FulfillmentService,
) {
  const router = Router(),
    attempts = new Map<string, { count: number; until: number }>();
  let inFlight = 0;
  const guard: RequestHandler = (request, response, next) => {
    const time = Date.now(),
      key = actorFor(request).userId;
    for (const [id, row] of attempts)
      if (row.until <= time) attempts.delete(id);
    const row = attempts.get(key);
    if ((row && row.count >= 10) || (!row && attempts.size >= 1000)) {
      response.setHeader("Retry-After", "60");
      next(
        new HttpError(
          429,
          "FULFILLMENT_RATE_LIMITED",
          "Too many fulfillment refresh attempts.",
        ),
      );
      return;
    }
    attempts.set(key, {
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
  };
  const error = (e: unknown) =>
    e instanceof AuthorizationError || e instanceof SessionError
      ? authorizationHttpError(e)
      : e instanceof FulfillmentError && e.code === "invalid_input"
        ? new HttpError(
            400,
            "INVALID_FULFILLMENT_REQUEST",
            "Invalid fulfillment refresh request.",
          )
        : e instanceof FulfillmentError && e.code === "forbidden"
          ? new HttpError(403, "FORBIDDEN", "Not permitted.")
          : e instanceof FulfillmentError && e.code === "not_found"
            ? new HttpError(
                404,
                "FULFILLMENT_NOT_FOUND",
                "Fulfillment refresh not found.",
              )
            : e instanceof FulfillmentError && e.code === "conflict"
              ? new HttpError(
                  409,
                  "FULFILLMENT_CONFLICT",
                  "Fulfillment refresh state conflicts. Refresh before trying again.",
                )
              : new HttpError(
                  503,
                  "FULFILLMENT_UNAVAILABLE",
                  "Fulfillment refresh operation could not be confirmed. Refresh order state.",
                );
  const path =
    "/api/v1/admin/companies/:companyId/orders/:orderId/fulfillment/refresh";
  router.post(
    path,
    authorize("orders.fulfillment.refresh", sessions),
    guard,
    json({ limit: "1kb", inflate: false }),
    async (request, response, next) => {
      if (inFlight >= 4) {
        next(
          new HttpError(
            503,
            "FULFILLMENT_UNAVAILABLE",
            "Fulfillment refresh is temporarily unavailable.",
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
        if (Object.keys(request.query).length)
          throw new FulfillmentError("invalid_input");
        if (!service) throw new FulfillmentError("unavailable");
        const result: FulfillmentResult = await service.refresh(
          actorFor(request),
          request.params.companyId,
          request.params.orderId,
          request.body,
          requestIdFor(response),
          controller.signal,
        );
        sendSuccess(response, result);
      } catch (e) {
        next(error(e));
      } finally {
        inFlight--;
        request.off("aborted", abort);
        response.off("close", abort);
      }
    },
  );
  return router;
}
