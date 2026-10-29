import type { HealthReport } from "@b2b-portal/contracts";
import type { RequestHandler } from "express";
import { requestIdFor } from "./http.js";

type LogEvent =
  | {
      event: "request.completed";
      requestId: string;
      method: string;
      statusCode?: number;
      durationMs: number;
      outcome: "completed" | "aborted";
    }
  | { event: "health.checked"; requestId: string; health: HealthReport }
  | { event: "api.started"; api: "up" }
  | { event: "postgres.pool_error" }
  | { event: "migrations.completed"; applied: number; skipped: number }
  | {
      event: "migrations.failed";
      reason: "invalid_environment" | "migration_failed";
    }
  | { event: "api.stopping"; reason: "SIGINT" | "SIGTERM" | "listen_failed" }
  | { event: "api.stopped" }
  | { event: "api.shutdown_failed"; reason: "timeout" | "cleanup_failed" }
  | {
      event: "api.start_failed";
      reason: "invalid_environment" | "listen_failed";
      diagnostic?: string;
    };

export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, event: LogEvent) => void;

export function createLogger(
  writeLine: (line: string, level: LogLevel) => void = (line, level) => {
    (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
  },
): Logger {
  return (level, event) => {
    writeLine(
      JSON.stringify({
        ...event,
        timestamp: new Date().toISOString(),
        level,
        service: "b2b-portal-api",
      }),
      level,
    );
  };
}

const methods = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
]);

export function requestLogging(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const requestId = requestIdFor(response);
    const started = performance.now();
    const method = methods.has(request.method) ? request.method : "OTHER";
    let logged = false;
    const log = (outcome: "completed" | "aborted") => {
      if (logged) return;
      logged = true;
      const statusCode =
        outcome === "completed" ? response.statusCode : undefined;
      const level =
        statusCode !== undefined && statusCode >= 500
          ? "error"
          : outcome === "aborted" ||
              (statusCode !== undefined && statusCode >= 400)
            ? "warn"
            : "info";
      logger(level, {
        event: "request.completed",
        requestId,
        method,
        statusCode,
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
        outcome,
      });
    };
    response.once("finish", () => log("completed"));
    response.once("close", () => log("aborted"));
    next();
  };
}
