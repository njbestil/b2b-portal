import { Router, json } from "express";
import type { LoginResult } from "@b2b-portal/contracts";
import type { LoginPrincipal } from "./repositories/authentication.js";
import { LoginError } from "./services/login.js";
import { HttpError, requestIdFor, sendSuccess } from "./http.js";

export type LoginHandler = (
  body: unknown,
  requestId: string,
) => Promise<LoginPrincipal>;
export function createLoginRouter(
  login: LoginHandler,
  now: () => number = Date.now,
) {
  const router = Router();
  // Direct peer IP only (Express trust proxy remains disabled). Bounded, process-local guard.
  const attempts = new Map<string, { count: number; until: number }>();
  router.post(
    "/api/v1/auth/login",
    (request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      const time = now(),
        key = request.ip ?? "unknown";
      for (const [ip, entry] of attempts)
        if (entry.until <= time) attempts.delete(ip);
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
            "LOGIN_RATE_LIMITED",
            "Too many login attempts. Try again later.",
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
      next();
    },
    json({ limit: "4kb", inflate: false }),
    async (request, response, next) => {
      try {
        const user = await login(request.body, requestIdFor(response));
        const result: LoginResult = { user };
        sendSuccess(response, result);
      } catch (error) {
        if (error instanceof LoginError) {
          if (error.code === "invalid_input")
            next(
              new HttpError(
                400,
                "INVALID_LOGIN_REQUEST",
                "Email and password are required.",
              ),
            );
          else if (error.code === "invalid_credentials")
            next(
              new HttpError(
                401,
                "INVALID_CREDENTIALS",
                "Invalid email or password.",
              ),
            );
          else
            next(
              new HttpError(
                503,
                "LOGIN_UNAVAILABLE",
                "Login is temporarily unavailable.",
              ),
            );
        } else
          next(
            new HttpError(
              503,
              "LOGIN_UNAVAILABLE",
              "Login is temporarily unavailable.",
            ),
          );
      }
    },
  );
  return router;
}
