import { Router, json } from "express";
import type { PasswordChangeResult } from "@b2b-portal/contracts";
import { HttpError, requestIdFor, sendSuccess } from "./http.js";
import { accessBearer, sessionHttpError } from "./session-route.js";
import {
  PasswordChangeError,
  type PasswordChangeHandler,
} from "./services/password-change.js";
export function createPasswordChangeRouter(change?: PasswordChangeHandler) {
  const router = Router(),
    attempts = new Map<string, { count: number; until: number }>();
  let inFlight = 0;
  router.post(
    "/api/v1/auth/change-password",
    (request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      const time = Date.now(),
        key = request.ip ?? "unknown";
      for (const [ip, row] of attempts)
        if (row.until <= time) attempts.delete(ip);
      const entry = attempts.get(key);
      if ((entry && entry.count >= 10) || (!entry && attempts.size >= 1000)) {
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
            "PASSWORD_CHANGE_RATE_LIMITED",
            "Too many password change attempts.",
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
      if (inFlight >= 2) {
        next(
          new HttpError(
            503,
            "PASSWORD_CHANGE_UNAVAILABLE",
            "Password change is temporarily unavailable.",
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
    },
    json({ limit: "4kb", inflate: false }),
    async (request, response, next) => {
      try {
        if (!change) throw new PasswordChangeError("unavailable");
        const result: PasswordChangeResult = await change(
          accessBearer(request.rawHeaders),
          request.body,
          requestIdFor(response),
        );
        sendSuccess(response, result);
      } catch (error) {
        if (error instanceof PasswordChangeError) {
          const code = error.code;
          next(
            code === "invalid_input"
              ? new HttpError(
                  400,
                  "INVALID_PASSWORD_CHANGE",
                  "Provide a different password with 8+ characters, uppercase, number and symbol.",
                )
              : code === "invalid_credentials"
                ? new HttpError(
                    401,
                    "INVALID_CREDENTIALS",
                    "Invalid current credentials.",
                  )
                : code === "not_required"
                  ? new HttpError(
                      409,
                      "PASSWORD_CHANGE_NOT_REQUIRED",
                      "First-login password change is not required.",
                    )
                  : new HttpError(
                      503,
                      "PASSWORD_CHANGE_UNAVAILABLE",
                      "Password change could not be confirmed. Try signing in again.",
                    ),
          );
        } else next(sessionHttpError(error));
      }
    },
  );
  return router;
}
