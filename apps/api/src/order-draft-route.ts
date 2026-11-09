import { Router, json, type RequestHandler } from "express";
import type { SessionService } from "./services/sessions.js";
import { DraftError, type OrderDraftService } from "./services/order-drafts.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, sendSuccess, requestIdFor } from "./http.js";
export function createOrderDraftRouter(
  sessions?: SessionService,
  service?: OrderDraftService,
) {
  const router = Router();
  const error = (e: unknown) =>
    e instanceof HttpError
      ? e
      : e instanceof AuthorizationError || e instanceof SessionError
        ? authorizationHttpError(e)
        : e instanceof DraftError && e.code === "invalid_quantity"
          ? new HttpError(
              400,
              "INVALID_ORDER_ITEM_QUANTITY",
              "Quantity must be a positive decimal with at most 12 integer and 6 fractional digits and meet the current product minimum.",
            )
          : e instanceof DraftError && e.code === "invalid_input"
            ? new HttpError(
                400,
                "INVALID_ORDER_DRAFT_REQUEST",
                "Invalid draft order request.",
              )
            : e instanceof DraftError && e.code === "forbidden"
              ? new HttpError(403, "FORBIDDEN", "Not permitted.")
              : e instanceof DraftError && e.code === "not_found"
                ? new HttpError(
                    404,
                    "ORDER_DRAFT_NOT_FOUND",
                    "Draft or reference not found.",
                  )
                : e instanceof DraftError && e.code === "conflict"
                  ? new HttpError(
                      409,
                      "ORDER_DRAFT_CONFLICT",
                      "Draft state changed or conflicts. Reload before another action.",
                    )
                  : new HttpError(
                      503,
                      "ORDER_DRAFT_UNAVAILABLE",
                      "Draft order operation could not be confirmed. Reload before another action.",
                    );
  router.get(
    "/api/v1/order-drafts/:id",
    authorize("order-drafts.read", sessions),
    async (request, response, next) => {
      try {
        if (Object.keys(request.query).length)
          throw new DraftError("invalid_input");
        if (!service) throw new DraftError("unavailable");
        sendSuccess(
          response,
          await service.find(actorFor(request), request.params.id),
        );
      } catch (e) {
        next(error(e));
      }
    },
  );
  let inFlight = 0;
  const attempts = new Map<string, { count: number; until: number }>();
  const guard: RequestHandler = (request, response, next) => {
    const time = Date.now(),
      key = actorFor(request).userId;
    for (const [id, value] of attempts)
      if (value.until <= time) attempts.delete(id);
    const row = attempts.get(key);
    if ((row?.count ?? 0) >= 30) {
      next(new HttpError(429, "RATE_LIMITED", "Too many draft changes."));
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
    if (inFlight >= 4) {
      next(error(new DraftError("unavailable")));
      return;
    }
    inFlight++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inFlight--;
      }
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  };
  router.post(
    "/api/v1/order-drafts/:id/validate",
    authorize("order-drafts.manage", sessions),
    guard,
    json({ limit: "8kb", inflate: false }),
    async (request, response, next) => {
      try {
        if (Object.keys(request.query).length)
          throw new DraftError("invalid_input");
        if (!service) throw new DraftError("unavailable");
        sendSuccess(
          response,
          await service.validate(
            actorFor(request),
            request.params.id,
            request.body,
          ),
        );
      } catch (e) {
        next(error(e));
      }
    },
  );
  for (const method of ["post", "patch", "delete"] as const) {
    router[method](
      method === "post" ? "/api/v1/order-drafts" : "/api/v1/order-drafts/:id",
      authorize("order-drafts.manage", sessions),
      guard,
      json({ limit: "8kb", inflate: false }),
      async (request, response, next) => {
        try {
          if (Object.keys(request.query).length)
            throw new DraftError("invalid_input");
          if (!service) throw new DraftError("unavailable");
          const actor = actorFor(request),
            requestId = requestIdFor(response);
          const result =
            method === "post"
              ? await service.create(actor, request.body, requestId)
              : method === "patch"
                ? await service.update(
                    actor,
                    request.params.id,
                    request.body,
                    requestId,
                  )
                : await service.remove(
                    actor,
                    request.params.id,
                    request.body,
                    requestId,
                  );
          sendSuccess(response, result, method === "post" ? 201 : 200);
        } catch (e) {
          next(error(e));
        }
      },
    );
  }
  router.get(
    "/api/v1/order-drafts/:id/items",
    authorize("order-drafts.read", sessions),
    async (request, response, next) => {
      try {
        if (Object.keys(request.query).length)
          throw new DraftError("invalid_input");
        if (!service) throw new DraftError("unavailable");
        sendSuccess(
          response,
          await service.items(actorFor(request), request.params.id),
        );
      } catch (e) {
        next(error(e));
      }
    },
  );
  for (const method of ["post", "patch", "delete"] as const) {
    router[method](
      method === "post"
        ? "/api/v1/order-drafts/:id/items"
        : "/api/v1/order-drafts/:id/items/:itemId",
      authorize("order-drafts.manage", sessions),
      guard,
      json({ limit: "8kb", inflate: false }),
      async (request, response, next) => {
        try {
          if (Object.keys(request.query).length)
            throw new DraftError("invalid_input");
          if (!service) throw new DraftError("unavailable");
          sendSuccess(
            response,
            await service.changeItem(
              actorFor(request),
              request.params.id,
              request.params.itemId,
              method === "post"
                ? "add"
                : method === "patch"
                  ? "update"
                  : "remove",
              request.body,
              requestIdFor(response),
            ),
            method === "post" ? 201 : 200,
          );
        } catch (e) {
          next(error(e));
        }
      },
    );
  }
  return router;
}
