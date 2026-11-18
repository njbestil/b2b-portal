import { Router, json, type RequestHandler } from "express";
import type { AdminSalesAssignmentResult } from "@b2b-portal/contracts";
import {
  AssignmentManagementError,
  type AdminSalesAssignmentService,
} from "./services/admin-sales-assignments.js";
import type { SessionService } from "./services/sessions.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { HttpError, requestIdFor, sendSuccess } from "./http.js";
export function createAdminSalesAssignmentRouter(
  sessions?: SessionService,
  service?: AdminSalesAssignmentService,
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
          "SALES_ASSIGNMENT_RATE_LIMITED",
          "Too many assignment-management attempts.",
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
          "SALES_ASSIGNMENT_UNAVAILABLE",
          "Sales assignment operation is temporarily unavailable.",
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
      : e instanceof AssignmentManagementError && e.code === "invalid_input"
        ? new HttpError(
            400,
            "INVALID_SALES_ASSIGNMENT_REQUEST",
            "Invalid sales assignment request.",
          )
        : e instanceof AssignmentManagementError && e.code === "forbidden"
          ? new HttpError(403, "FORBIDDEN", "Not permitted.")
          : e instanceof AssignmentManagementError && e.code === "not_found"
            ? new HttpError(
                404,
                "SALES_ASSIGNMENT_NOT_FOUND",
                "Sales assignment not found.",
              )
            : e instanceof AssignmentManagementError && e.code === "conflict"
              ? new HttpError(
                  409,
                  "SALES_ASSIGNMENT_CONFLICT",
                  "Sales assignment state conflicts. Refresh before trying again.",
                )
              : new HttpError(
                  503,
                  "SALES_ASSIGNMENT_UNAVAILABLE",
                  "Sales assignment operation could not be confirmed. Refresh assignment state.",
                );
  const path = "/api/v1/admin/companies/:companyId/sales-assignment";
  router.get(
    path,
    authorize("sales-assignments.manage", sessions),
    async (request, response, next) => {
      try {
        if (Object.keys(request.query).length)
          throw new AssignmentManagementError("invalid_input");
        if (!service) throw new AssignmentManagementError("unavailable");
        const result: AdminSalesAssignmentResult = await service.current(
          actorFor(request),
          request.params.companyId,
        );
        sendSuccess(response, result);
      } catch (e) {
        next(error(e));
      }
    },
  );
  router.put(
    path,
    authorize("sales-assignments.manage", sessions),
    guard,
    json({ limit: "4kb", inflate: false }),
    async (request, response, next) => {
      try {
        if (Object.keys(request.query).length)
          throw new AssignmentManagementError("invalid_input");
        if (!service) throw new AssignmentManagementError("unavailable");
        const result: AdminSalesAssignmentResult = await service.assign(
          actorFor(request),
          request.params.companyId,
          request.body,
          requestIdFor(response),
        );
        sendSuccess(response, result);
      } catch (e) {
        next(error(e));
      }
    },
  );
  return router;
}
