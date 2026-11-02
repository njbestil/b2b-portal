import { Router, json } from "express";
import type { SessionService } from "./services/sessions.js";
import { SessionError, requireNormalAccess } from "./services/session-state.js";
import { HttpError, requestIdFor, sendSuccess } from "./http.js";

export function sessionHttpError(error: unknown): HttpError {
  if (error instanceof SessionError) {
    if (error.code === "invalid_proof")
      return new HttpError(
        401,
        "INVALID_SESSION",
        "Invalid or expired authentication.",
      );
    if (error.code === "restricted")
      return new HttpError(
        403,
        "PASSWORD_CHANGE_REQUIRED",
        "Change your password before continuing.",
      );
    if (error.code === "invalid_input")
      return new HttpError(
        400,
        "INVALID_SESSION_REQUEST",
        "Invalid authentication request.",
      );
  }
  return new HttpError(
    503,
    "AUTH_UNAVAILABLE",
    "Authentication is temporarily unavailable.",
  );
}
/** Use raw headers to reject duplicates instead of trusting Node's merged value. */
export function accessBearer(rawHeaders: readonly string[]): string {
  const values: string[] = [];
  for (let n = 0; n < rawHeaders.length; n += 2)
    if (rawHeaders[n]?.toLowerCase() === "authorization")
      values.push(rawHeaders[n + 1] ?? "");
  if (
    values.length !== 1 ||
    !/^Bearer [A-Za-z0-9_.-]{1,4096}$/i.test(values[0]!)
  )
    throw new SessionError("invalid_proof");
  return values[0]!.slice(7);
}
export function createSessionRouter(service?: SessionService) {
  const router = Router(),
    attempts = new Map<string, { count: number; until: number }>();
  let inFlight = 0;
  router.post(
    "/api/v1/auth/refresh",
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
            "REFRESH_RATE_LIMITED",
            "Too many authentication attempts.",
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
        if (!service) throw new SessionError("unavailable");
        sendSuccess(
          response,
          await service.refresh(request.body, requestIdFor(response)),
        );
      } catch (error) {
        next(sessionHttpError(error));
      }
    },
  );
  router.get("/api/v1/auth/me", async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      if (!service) throw new SessionError("unavailable");
      const principal = await service.authenticateAccess(
        accessBearer(request.rawHeaders),
      );
      requireNormalAccess(principal);
      sendSuccess(response, {
        user: {
          id: principal.userId,
          role: principal.role,
          companyId: principal.companyId,
          mustChangePassword: principal.mustChangePassword,
        },
      });
    } catch (error) {
      next(sessionHttpError(error));
    }
  });
  return router;
}
