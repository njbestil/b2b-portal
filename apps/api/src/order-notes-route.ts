import { Router, json, type RequestHandler } from "express";
import type { SessionService } from "./services/sessions.js";
import type { OrderNotesService } from "./services/order-notes.js";
import { InternalNoteError } from "./services/internal-notes.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import { CompanyProfileError } from "./services/company-profiles.js";
import { SalesAssignmentError } from "./services/sales-assignments.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess, requestIdFor } from "./http.js";
export function createOrderNotesRouter(
  sessions?: SessionService,
  service?: OrderNotesService,
) {
  const router = Router(),
    path = "/api/v1/companies/:companyId/orders/:orderId/internal-notes",
    attempts = new Map<string, { count: number; until: number }>();
  let inFlight = 0;
  const guard: RequestHandler = (req, res, next) => {
    const actor = actorFor(req);
    if (!["INTERNAL_ADMIN", "SALES_STAFF"].includes(actor.role)) {
      next(new HttpError(403, "FORBIDDEN", "Not permitted."));
      return;
    }
    if (inFlight >= 4) {
      next(
        new HttpError(
          503,
          "ORDER_NOTES_UNAVAILABLE",
          "Internal notes unavailable.",
        ),
      );
      return;
    }
    if (req.method === "POST") {
      const time = Date.now();
      for (const [id, v] of attempts) if (v.until <= time) attempts.delete(id);
      const v = attempts.get(actor.userId);
      if ((v?.count ?? 0) >= 30 || (!v && attempts.size >= 1000)) {
        next(new HttpError(429, "RATE_LIMITED", "Too many note changes."));
        return;
      }
      attempts.set(actor.userId, {
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
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inFlight--;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
  const handle: RequestHandler = async (req, res, next) => {
    try {
      if (!service) throw new InternalNoteError("storage_failed");
      let value;
      if (req.method === "POST") {
        if (Object.keys(req.query).length)
          throw new InternalNoteError("invalid_note");
        value = await service.add(
          actorFor(req),
          req.params.companyId,
          req.params.orderId,
          req.body,
          requestIdFor(res),
        );
      } else {
        if (
          Object.keys(req.query).some((k) => !["offset", "limit"].includes(k))
        )
          throw new InternalNoteError("invalid_note");
        const number = (x: unknown, fallback: number) => {
          if (x === undefined) return fallback;
          if (typeof x !== "string" || !/^\d{1,6}$/.test(x))
            throw new InternalNoteError("invalid_note");
          return Number(x);
        };
        value = await service.list(
          actorFor(req),
          req.params.companyId,
          req.params.orderId,
          {
            offset: number(req.query.offset, 0),
            limit: number(req.query.limit, 20),
          },
        );
      }
      sendSuccess(res, value, req.method === "POST" ? 201 : 200);
    } catch (e) {
      if (e instanceof AuthorizationError || e instanceof SessionError)
        next(authorizationHttpError(e));
      else {
        const code =
            e instanceof InternalNoteError ||
            e instanceof CompanyProfileError ||
            e instanceof SalesAssignmentError
              ? e.code
              : "storage_failed",
          status =
            code === "invalid_note" || code === "invalid_input"
              ? 400
              : code === "forbidden"
                ? 403
                : code === "not_found"
                  ? 404
                  : 503;
        next(
          new HttpError(
            status,
            status === 400
              ? "INVALID_ORDER_NOTE_REQUEST"
              : status === 403
                ? "FORBIDDEN"
                : status === 404
                  ? "ORDER_NOT_FOUND"
                  : "ORDER_NOTES_UNAVAILABLE",
            "Internal note operation could not be confirmed. Reload before another action.",
          ),
        );
      }
    }
  };
  router.get(path, authorize("orders.read", sessions), guard, handle);
  router.post(
    path,
    authorize("orders.read", sessions),
    guard,
    json({ limit: "32kb", inflate: false }),
    handle,
  );
  return router;
}
