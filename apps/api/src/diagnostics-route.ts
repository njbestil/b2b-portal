import { Router, type Request } from "express";
import type { AdminDiagnostics } from "@b2b-portal/contracts";
import {
  authorize,
  actorFor,
  authorizationHttpError,
} from "./authorization-middleware.js";
import type { SessionService } from "./services/sessions.js";
import {
  DiagnosticsError,
  type DiagnosticsService,
} from "./services/diagnostics.js";
import { AuthorizationError } from "./services/authorization.js";
import { SessionError } from "./services/session-state.js";
import { HttpError, sendSuccess } from "./http.js";
export function createDiagnosticsRouter(
  sessions?: SessionService,
  diagnostics?: DiagnosticsService,
) {
  const router = Router(),
    results = new WeakMap<Request, AdminDiagnostics>();
  router.get(
    "/api/v1/admin/diagnostics",
    authorize("diagnostics.read", sessions),
    async (request, _response, next) => {
      try {
        if (Object.keys(request.query).length)
          throw new HttpError(
            400,
            "INVALID_DIAGNOSTICS_QUERY",
            "Invalid diagnostics query.",
          );
        if (!diagnostics) throw new DiagnosticsError("unavailable");
        results.set(request, await diagnostics.report(actorFor(request)));
        next();
      } catch (e) {
        next(
          e instanceof AuthorizationError || e instanceof SessionError
            ? authorizationHttpError(e)
            : e instanceof HttpError
              ? e
              : new HttpError(
                  503,
                  e instanceof DiagnosticsError && e.code === "busy"
                    ? "DIAGNOSTICS_BUSY"
                    : "DIAGNOSTICS_UNAVAILABLE",
                  "Diagnostics are temporarily unavailable.",
                ),
        );
      }
    },
    // Current role, status, credential binding, revocation and expiry may change
    // while probes wait. Re-admit before exposing the fixed report projection.
    authorize("diagnostics.read", sessions),
    (request, response, next) => {
      try {
        if (!diagnostics) throw new DiagnosticsError("unavailable");
        diagnostics.checkAccess(actorFor(request));
        const result = results.get(request);
        if (!result) throw new DiagnosticsError("unavailable");
        sendSuccess(response, result);
      } catch (e) {
        next(
          e instanceof AuthorizationError || e instanceof SessionError
            ? authorizationHttpError(e)
            : new HttpError(
                503,
                "DIAGNOSTICS_UNAVAILABLE",
                "Diagnostics are temporarily unavailable.",
              ),
        );
      }
    },
  );
  return router;
}
