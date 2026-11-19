import type { RequestHandler } from "express";
import { HttpError } from "./http.js";

/** API-wide, process-local protection; route-specific guards remain in force. */
export function createRequestGuard(
  now: () => number = Date.now,
  limit = 600,
  capacity = 1000,
): RequestHandler {
  const entries = new Map<string, { count: number; until: number }>();
  return (request, response, next) => {
    // A saturated client bucket must not make load-balancer health probes fail.
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      request.path === "/health"
    ) {
      next();
      return;
    }
    const time = now();
    for (const [key, value] of entries) {
      if (value.until <= time) entries.delete(key);
    }
    // Never trust forwarded headers; Express proxy trust remains disabled.
    const key = request.socket.remoteAddress ?? "unknown";
    const entry = entries.get(key);
    if (
      (entry && entry.count >= limit) ||
      (!entry && entries.size >= capacity)
    ) {
      response.setHeader("Cache-Control", "no-store");
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
          "RATE_LIMITED",
          "Too many requests. Try again later.",
        ),
      );
      return;
    }
    entries.set(key, {
      count: (entry?.count ?? 0) + 1,
      until: entry?.until ?? time + 60000,
    });
    next();
  };
}

export const securityHeaders: RequestHandler = (_request, response, next) => {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
};
