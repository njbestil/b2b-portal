import { Router, json } from "express";
import type { AccountStatusResult } from "@b2b-portal/contracts";
import type { AccountStatusService } from "./services/account-status.js";
import { AccountStatusError } from "./services/account-status.js";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import type { SessionService } from "./services/sessions.js";
import { HttpError, sendSuccess, requestIdFor } from "./http.js";
export function createAccountStatusRouter(
  sessions?: SessionService,
  service?: AccountStatusService,
) {
  const router = Router();
  for (const [collection, kind] of [
    ["users", "user"],
    ["companies", "company"],
  ] as const) {
    const path = "/api/v1/admin/" + collection + "/:id/status";
    const error = (e: unknown) =>
      e instanceof AuthorizationError || e instanceof SessionError
        ? authorizationHttpError(e)
        : e instanceof AccountStatusError && e.code === "invalid_input"
          ? new HttpError(
              400,
              "INVALID_STATUS_REQUEST",
              "Invalid status request.",
            )
          : e instanceof AccountStatusError && e.code === "forbidden"
            ? new HttpError(403, "FORBIDDEN", "Not permitted.")
            : e instanceof AccountStatusError && e.code === "not_found"
              ? new HttpError(404, "ACCOUNT_NOT_FOUND", "Account not found.")
              : e instanceof AccountStatusError && e.code === "conflict"
                ? new HttpError(
                    409,
                    "STATUS_CONFLICT",
                    "Account status changed. Refresh before trying again.",
                  )
                : new HttpError(
                    503,
                    "STATUS_UNAVAILABLE",
                    "Status could not be confirmed. Refresh account status.",
                  );
    router.get(
      path,
      authorize("accounts.status.read", sessions),
      async (request, response, next) => {
        try {
          if (Object.keys(request.query).length)
            throw new AccountStatusError("invalid_input");
          if (!service) throw new AccountStatusError("unavailable");
          const result: AccountStatusResult = await service.current(
            actorFor(request),
            kind,
            request.params.id,
          );
          sendSuccess(response, result);
        } catch (e) {
          next(error(e));
        }
      },
    );
    router.patch(
      path,
      authorize("accounts.status.write", sessions),
      (request, _response, next) => {
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
        try {
          if (Object.keys(request.query).length)
            throw new AccountStatusError("invalid_input");
          if (!service) throw new AccountStatusError("unavailable");
          const result: AccountStatusResult = await service.change(
            actorFor(request),
            kind,
            request.params.id,
            request.body,
            requestIdFor(response),
          );
          sendSuccess(response, result);
        } catch (e) {
          next(error(e));
        }
      },
    );
  }
  return router;
}
