import {
  EnvironmentConfigurationError,
  parsePostgresEnvironment,
  parseServerEnvironment,
} from "@b2b-portal/config/server";
import { createApp } from "./app.js";
import { createLogger } from "./logging.js";
import { createPostgres } from "./infrastructure/postgres.js";
import { createShutdown, type ShutdownReason } from "./shutdown.js";

const logger = createLogger();

try {
  const config = parseServerEnvironment("api", process.env);
  const postgresConfig = parsePostgresEnvironment(process.env);
  const postgres = postgresConfig
    ? createPostgres(postgresConfig, logger)
    : undefined;
  const app = createApp({
    logger,
    healthChecks: { storage: postgres?.health },
  });
  const server = app.listen(config.port, config.host);
  const shutdown = createShutdown(
    server,
    () => postgres?.close() ?? Promise.resolve(),
    logger,
  );
  const stop = (reason: ShutdownReason) => {
    void shutdown(reason).then((clean) => {
      if (!clean) process.exitCode = 1;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    });
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  server.once("listening", () => {
    logger("info", { event: "api.started", api: "up" });
  });
  server.on("error", () => {
    logger("error", { event: "api.start_failed", reason: "listen_failed" });
    process.exitCode = 1;
    stop("listen_failed");
  });
} catch (error) {
  if (!(error instanceof EnvironmentConfigurationError)) {
    throw error;
  }
  logger("error", {
    event: "api.start_failed",
    reason: "invalid_environment",
    // This validator only includes setting names/rules, never their values.
    diagnostic: error.message,
  });
  process.exitCode = 1;
}
