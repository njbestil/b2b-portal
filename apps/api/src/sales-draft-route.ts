import { Router, json, type RequestHandler } from "express";
import type { SessionService } from "./services/sessions.js";
import { DraftError, type SalesDraftService } from "./services/order-drafts.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess, requestIdFor } from "./http.js";
export function createSalesDraftRouter(
  sessions?: SessionService,
  service?: SalesDraftService,
) {
  const router = Router(),
    path = "/api/v1/sales/companies/:companyId/order-drafts";
  let inFlight = 0;
  const attempts = new Map<string, { count: number; until: number }>();
  const guard: RequestHandler = (req, res, next) => {
    const now = Date.now(),
      key = actorFor(req).userId;
    for (const [id, v] of attempts) if (v.until <= now) attempts.delete(id);
    const v = attempts.get(key);
    if ((v?.count ?? 0) >= 30 || (!v && attempts.size >= 1000)) {
      next(new HttpError(429, "RATE_LIMITED", "Too many draft operations."));
      return;
    }
    if (inFlight >= 4) {
      next(
        new HttpError(
          503,
          "ORDER_DRAFT_UNAVAILABLE",
          "Draft operation is unavailable.",
        ),
      );
      return;
    }
    if (req.method !== "GET" && !req.is("application/json")) {
      next(
        new HttpError(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "A JSON body is required.",
        ),
      );
      return;
    }
    attempts.set(key, {
      count: (v?.count ?? 0) + 1,
      until: v?.until ?? now + 60000,
    });
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
  function route(
    method: "get" | "post" | "patch" | "delete",
    suffix: string,
    operation:
      | "create"
      | "find"
      | "update"
      | "items"
      | "add"
      | "updateItem"
      | "removeItem",
  ) {
    router[method](
      path + suffix,
      authorize("sales-drafts.manage", sessions),
      guard,
      json({ limit: "2kb", inflate: false }),
      async (req, res, next) => {
        try {
          if (Object.keys(req.query).length)
            throw new DraftError("invalid_input");
          if (!service) throw new DraftError("unavailable");
          const s = service(req.params.companyId as string),
            actor = actorFor(req),
            id = req.params.id as string,
            requestId = requestIdFor(res);
          const value =
            operation === "create"
              ? await s.create(actor, req.body, requestId)
              : operation === "find"
                ? await s.find(actor, id)
                : operation === "update"
                  ? await s.update(actor, id, req.body, requestId)
                  : operation === "items"
                    ? await s.items(actor, id)
                    : await s.changeItem(
                        actor,
                        id,
                        req.params.itemId,
                        operation === "add"
                          ? "add"
                          : operation === "updateItem"
                            ? "update"
                            : "remove",
                        req.body,
                        requestId,
                      );
          sendSuccess(res, value, operation === "create" ? 201 : 200);
        } catch (e) {
          if (e instanceof AuthorizationError || e instanceof SessionError)
            next(authorizationHttpError(e));
          else {
            const code = e instanceof DraftError ? e.code : "unavailable",
              status =
                code === "invalid_input" || code === "invalid_quantity"
                  ? 400
                  : code === "forbidden"
                    ? 403
                    : code === "not_found"
                      ? 404
                      : code === "conflict"
                        ? 409
                        : 503;
            next(
              new HttpError(
                status,
                status === 400
                  ? "INVALID_ORDER_DRAFT_REQUEST"
                  : status === 403
                    ? "FORBIDDEN"
                    : status === 404
                      ? "ORDER_DRAFT_NOT_FOUND"
                      : status === 409
                        ? "ORDER_DRAFT_CONFLICT"
                        : "ORDER_DRAFT_UNAVAILABLE",
                "Draft operation could not be confirmed. Reload before another action.",
              ),
            );
          }
        }
      },
    );
  }
  route("post", "", "create");
  route("get", "/:id", "find");
  route("patch", "/:id", "update");
  route("get", "/:id/items", "items");
  route("post", "/:id/items", "add");
  route("patch", "/:id/items/:itemId", "updateItem");
  route("delete", "/:id/items/:itemId", "removeItem");
  return router;
}
