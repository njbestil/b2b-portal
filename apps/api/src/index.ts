import {
  EnvironmentConfigurationError,
  parseErpEnvironment,
  parsePostgresEnvironment,
  parseServerEnvironment,
  parseStorageEnvironment,
} from "@b2b-portal/config/server";
import { createApp } from "./app.js";
import { createLogger } from "./logging.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectStorage,
  type StorageRuntime,
} from "./infrastructure/storage.js";
import { MockErpAdapter } from "./infrastructure/mock-erp-adapter.js";
import { createErpHealthProbe } from "./services/erp-health.js";
import { createShutdown, type ShutdownReason } from "./shutdown.js";

const logger = createLogger();
let storage: StorageRuntime | undefined;

try {
  const config = parseServerEnvironment("api", process.env);
  const postgresConfig = parsePostgresEnvironment(process.env);
  const erpConfig = parseErpEnvironment(process.env);
  const storageConfig = parseStorageEnvironment(process.env);
  storage = await selectStorage({
    postgres: postgresConfig,
    jsonDirectory: resolve(
      fileURLToPath(new URL("../", import.meta.url)),
      storageConfig.jsonDataDir ?? "data/runtime",
    ),
    startupTimeoutMs: storageConfig.startupTimeoutMs,
    logger,
  });
  const selectedStorage = storage;
  const app = createApp({
    logger,
    storageProvider: selectedStorage.provider,
    healthChecks: {
      storage: selectedStorage.health,
      erp: erpConfig
        ? createErpHealthProbe(new MockErpAdapter(erpConfig))
        : undefined,
    },
  });
  const server = app.listen(config.port, config.host);
  const shutdown = createShutdown(
    server,
    () => selectedStorage.close(),
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
    logger("info", {
      event: "api.started",
      api: "up",
      storageProvider: selectedStorage.provider,
    });
  });
  server.on("error", () => {
    logger("error", { event: "api.start_failed", reason: "listen_failed" });
    process.exitCode = 1;
    stop("listen_failed");
  });
} catch (error) {
  await storage?.close().catch(() => {});
  logger("error", {
    event: "api.start_failed",
    reason:
      error instanceof EnvironmentConfigurationError
        ? "invalid_environment"
        : "storage_initialization_failed",
    // This validator only includes setting names/rules, never their values.
    ...(error instanceof EnvironmentConfigurationError
      ? { diagnostic: error.message }
      : {}),
  });
  process.exitCode = 1;
}
