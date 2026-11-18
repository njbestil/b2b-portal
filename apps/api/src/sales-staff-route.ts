import { Router, json, type RequestHandler } from "express";
import type { SalesStaffResult } from "@b2b-portal/contracts";
import {
  SalesStaffError,
  type SalesStaffService,
} from "./services/sales-staff.js";
import type { SessionService } from "./services/sessions.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, requestIdFor, sendSuccess } from "./http.js";
export function createSalesStaffRouter(
  sessions?: SessionService,
  service?: SalesStaffService,
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
          "SALES_STAFF_RATE_LIMITED",
          "Too many user-management attempts.",
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
    if (inFlight >= 4) {
      next(
        new HttpError(
          503,
          "SALES_STAFF_UNAVAILABLE",
          "Sales staff operation is temporarily unavailable.",
        ),
      );
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
  const error = (e: unknown) =>
    e instanceof AuthorizationError || e instanceof SessionError
      ? authorizationHttpError(e)
      : e instanceof SalesStaffError && e.code === "invalid_input"
        ? new HttpError(
            400,
            "INVALID_SALES_STAFF_REQUEST",
            "Invalid sales staff request.",
          )
        : e instanceof SalesStaffError && e.code === "forbidden"
          ? new HttpError(403, "FORBIDDEN", "Not permitted.")
          : e instanceof SalesStaffError && e.code === "not_found"
            ? new HttpError(
                404,
                "SALES_STAFF_NOT_FOUND",
                "Sales staff not found.",
              )
            : e instanceof SalesStaffError && e.code === "conflict"
              ? new HttpError(
                  409,
                  "SALES_STAFF_CONFLICT",
                  "Sales staff state conflicts. Refresh before trying again.",
                )
              : new HttpError(
                  503,
                  "SALES_STAFF_UNAVAILABLE",
                  "Sales staff operation could not be confirmed. Refresh user data.",
                );
  for (const [path, create] of [
    ["/api/v1/admin/sales-staff", true],
    ["/api/v1/admin/sales-staff/:id/deactivate", false],
    ["/api/v1/admin/sales-staff/:id/activate", false],
  ] as const) {
    router.post(
      path,
      authorize("sales-staff.manage", sessions),
      guard,
      json({ limit: "8kb", inflate: false }),
      async (request, response, next) => {
        try {
          if (Object.keys(request.query).length)
            throw new SalesStaffError("invalid_input");
          if (!service) throw new SalesStaffError("unavailable");
          const result: SalesStaffResult = create
            ? await service.create(
                actorFor(request),
                request.body,
                requestIdFor(response),
              )
            : await service.change(
                actorFor(request),
                request.params.id,
                request.body,
                path.endsWith("/activate") ? "ACTIVE" : "DEACTIVATED",
                requestIdFor(response),
              );
          sendSuccess(response, result, create ? 201 : 200);
        } catch (e) {
          next(error(e));
        }
      },
    );
  }
  return router;
}
