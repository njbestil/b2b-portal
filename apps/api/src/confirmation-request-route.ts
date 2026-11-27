import { Router, json, type RequestHandler } from "express";
import type { SessionService } from "./services/sessions.js";
import type { ConfirmationRequestService } from "./services/confirmation-requests.js";
import { DraftError } from "./services/order-drafts.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess, requestIdFor } from "./http.js";
export function createConfirmationRequestRouter(
  sessions?: SessionService,
  service?: ConfirmationRequestService,
) {
  const router = Router(),
    path = "/api/v1/sales/companies/:companyId/orders/:orderId/confirmation",
    attempts = new Map<string, { count: number; until: number }>();
  let inFlight = 0;
  const guard: RequestHandler = (req, res, next) => {
    const time = Date.now(),
      id = actorFor(req).userId;
    for (const [k, v] of attempts) if (v.until <= time) attempts.delete(k);
    const v = attempts.get(id);
    if (inFlight >= 4) {
      next(
        new HttpError(
          503,
          "CONFIRMATION_UNAVAILABLE",
          "Confirmation request unavailable.",
        ),
      );
      return;
    }
    if (req.method === "POST") {
      if ((v?.count ?? 0) >= 20 || (!v && attempts.size >= 1000)) {
        next(
          new HttpError(429, "RATE_LIMITED", "Too many confirmation requests."),
        );
        return;
      }
      attempts.set(id, {
        count: (v?.count ?? 0) + 1,
        until: v?.until ?? time + 60000,
      });
      if (!req.is("application/json")) {
        next(
          new HttpError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "A JSON body is required.",
          ),
        );
        return;
      }
    }
    inFlight++;
    let done = false;
    const release = () => {
      if (!done) {
        done = true;
        inFlight--;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
  const handle: RequestHandler = async (req, res, next) => {
    try {
      if (!service) throw new DraftError("unavailable");
      if (Object.keys(req.query).length) throw new DraftError("invalid_input");
      if (
        req.method === "POST" &&
        req.rawHeaders.filter(
          (h, i) => i % 2 === 0 && h.toLowerCase() === "idempotency-key",
        ).length !== 1
      )
        throw new DraftError("invalid_input");
      const actor = actorFor(req),
        value =
          req.method === "GET"
            ? await service.find(
                actor,
                req.params.companyId,
                req.params.orderId,
              )
            : await service.request(
                actor,
                req.params.companyId,
                req.params.orderId,
                req.get("Idempotency-Key"),
                req.body,
                requestIdFor(res),
              );
      sendSuccess(res, value, req.method === "GET" ? 200 : 202);
    } catch (e) {
      if (e instanceof AuthorizationError || e instanceof SessionError)
        next(authorizationHttpError(e));
      else {
        const c = e instanceof DraftError ? e.code : "unavailable",
          status =
            c === "invalid_input"
              ? 400
              : c === "forbidden"
                ? 403
                : c === "not_found"
                  ? 404
                  : c === "conflict"
                    ? 409
                    : 503;
        next(
          new HttpError(
            status,
            status === 400
              ? "INVALID_CONFIRMATION_REQUEST"
              : status === 403
                ? "FORBIDDEN"
                : status === 404
                  ? "CONFIRMATION_NOT_FOUND"
                  : status === 409
                    ? "CONFIRMATION_CONFLICT"
                    : "CONFIRMATION_UNAVAILABLE",
            "Confirmation operation could not be confirmed. Check its status before another action.",
          ),
        );
      }
    }
  };
  router.get(path, authorize("sales-drafts.manage", sessions), guard, handle);
  router.post(
    path,
    authorize("sales-drafts.manage", sessions),
    guard,
    json({ limit: "2kb", inflate: false }),
    handle,
  );
  return router;
}
