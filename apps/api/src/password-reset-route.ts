import { Router, json } from "express";
import { HttpError, requestIdFor, sendSuccess } from "./http.js";
import {
  PasswordResetError,
  type PasswordResetService,
} from "./services/password-reset.js";
export function createPasswordResetRouter(service?: PasswordResetService) {
  const router = Router(),
    attempts = new Map<string, { count: number; until: number }>();
  let inFlight = 0;
  for (const action of ["forgot-password", "reset-password"] as const) {
    router.post(
      "/api/v1/auth/" + action,
      (request, response, next) => {
        response.setHeader("Cache-Control", "no-store");
        const time = Date.now(),
          key = request.ip ?? "unknown";
        for (const [k, row] of attempts)
          if (row.until <= time) attempts.delete(k);
        const row = attempts.get(key);
        if ((row && row.count >= 10) || (!row && attempts.size >= 1000)) {
          response.setHeader(
            "Retry-After",
            String(
              Math.max(
                1,
                Math.ceil(((row?.until ?? time + 60000) - time) / 1000),
              ),
            ),
          );
          next(
            new HttpError(
              429,
              "RESET_RATE_LIMITED",
              "Too many recovery attempts.",
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
        if (inFlight >= 2) {
          next(
            new HttpError(
              503,
              "RESET_UNAVAILABLE",
              "Password recovery is temporarily unavailable.",
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
          if (!service) throw new PasswordResetError("unavailable");
          const result =
            action === "forgot-password"
              ? await service.request(request.body, requestIdFor(response))
              : await service.redeem(request.body, requestIdFor(response));
          sendSuccess(
            response,
            result,
            action === "forgot-password" ? 202 : 200,
          );
        } catch (e) {
          const code = e instanceof PasswordResetError ? e.code : "unavailable";
          next(
            code === "invalid_input"
              ? new HttpError(
                  400,
                  "INVALID_RESET_REQUEST",
                  "Invalid password recovery request.",
                )
              : code === "invalid_proof"
                ? new HttpError(
                    401,
                    "INVALID_RESET_TOKEN",
                    "Invalid or expired reset proof.",
                  )
                : new HttpError(
                    503,
                    "RESET_UNAVAILABLE",
                    "Recovery could not be confirmed. Try signing in again.",
                  ),
          );
        }
      },
    );
  }
  return router;
}
