import {
  EnvironmentConfigurationError,
  parseServerEnvironment,
} from "@b2b-portal/config/server";
import { createApp } from "./app.js";
import { createLogger } from "./logging.js";

const logger = createLogger();

try {
  const config = parseServerEnvironment("api", process.env);
  const app = createApp({ logger });
  const server = app.listen(config.port, config.host);
  server.once("listening", () => {
    logger("info", { event: "api.started", api: "up" });
  });
  server.on("error", () => {
    logger("error", { event: "api.start_failed", reason: "listen_failed" });
    process.exitCode = 1;
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
