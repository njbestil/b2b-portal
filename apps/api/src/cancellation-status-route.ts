import { Router } from "express";
import type { SessionService } from "./services/sessions.js";
import type { CancellationStatusReader } from "./services/cancellation-status.js";
import { CancellationError } from "./services/cancellation.js";
import { CompanyProfileError } from "./services/company-profiles.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess } from "./http.js";
export function createCancellationStatusRouter(
  sessions?: SessionService,
  read?: CancellationStatusReader,
) {
  const router = Router();
  let inFlight = 0;
  router.get(
    "/api/v1/companies/:companyId/orders/:orderId/cancellations",
    authorize("orders.cancel", sessions),
    async (request, response, next) => {
      if (inFlight >= 4) {
        next(
          new HttpError(
            503,
            "CANCELLATION_UNAVAILABLE",
            "Cancellation status is unavailable.",
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
        if (!read) throw new CancellationError("unavailable");
        if (Object.keys(request.query).length)
          throw new CancellationError("invalid_input");
        sendSuccess(
          response,
          await read(
            actorFor(request),
            request.params.companyId,
            request.params.orderId,
            controller.signal,
          ),
        );
      } catch (e) {
        if (e instanceof AuthorizationError || e instanceof SessionError)
          next(authorizationHttpError(e));
        else if (
          (e instanceof CancellationError ||
            e instanceof CompanyProfileError) &&
          e.code === "invalid_input"
        )
          next(
            new HttpError(
              400,
              "INVALID_CANCELLATION_REQUEST",
              "Invalid cancellation request.",
            ),
          );
        else if (
          (e instanceof CancellationError ||
            e instanceof CompanyProfileError) &&
          e.code === "forbidden"
        )
          next(new HttpError(403, "FORBIDDEN", "Not permitted."));
        else if (
          (e instanceof CancellationError ||
            e instanceof CompanyProfileError) &&
          e.code === "not_found"
        )
          next(
            new HttpError(404, "CANCELLATION_NOT_FOUND", "Order not found."),
          );
        else
          next(
            new HttpError(
              503,
              "CANCELLATION_UNAVAILABLE",
              "Cancellation status is unavailable.",
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
