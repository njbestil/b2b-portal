import { Router, json } from "express";
import type { LogoutResult } from "@b2b-portal/contracts";
import type { SessionService } from "./services/sessions.js";
import { SessionError } from "./services/session-state.js";
import { accessBearer, sessionHttpError } from "./session-route.js";
import { HttpError, requestIdFor, sendSuccess } from "./http.js";

export function createLogoutRouter(service?: SessionService) {
  const router = Router(),
    attempts = new Map<string, { count: number; until: number }>();
  let inFlight = 0;
  router.post(
    "/api/v1/auth/logout",
    (request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      const time = Date.now(),
        key = request.ip ?? "unknown";
      for (const [ip, row] of attempts)
        if (row.until <= time) attempts.delete(ip);
      const entry = attempts.get(key);
      if ((entry && entry.count >= 30) || (!entry && attempts.size >= 1000)) {
        response.setHeader(
          "Retry-After",
          String(
            Math.max(
              1,
              Math.ceil(((entry?.until ?? time + 60000) - time) / 1000),
            ),
          ),
        );
        next(
          new HttpError(
            429,
            "LOGOUT_RATE_LIMITED",
            "Too many logout attempts.",
          ),
        );
        return;
      }
      attempts.set(key, {
        count: (entry?.count ?? 0) + 1,
        until: entry?.until ?? time + 60000,
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
      if (inFlight >= 8) {
        next(sessionHttpError(new SessionError("unavailable")));
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
    },
    json({ limit: "4kb", inflate: false }),
    async (request, response, next) => {
      try {
        const body: unknown = request.body;
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length
        )
          throw new SessionError("invalid_input");
        if (!service) throw new SessionError("unavailable");
        await service.revoke(
          accessBearer(request.rawHeaders),
          requestIdFor(response),
        );
        const result: LogoutResult = { loggedOut: true };
        sendSuccess(response, result);
      } catch (error) {
        next(sessionHttpError(error));
      }
    },
  );
  return router;
}
