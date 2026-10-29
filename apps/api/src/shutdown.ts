import type { Server } from "node:http";
import type { Logger } from "./logging.js";

export type ShutdownReason = "SIGINT" | "SIGTERM" | "listen_failed";

export function createShutdown(
  server: Pick<Server, "close" | "closeAllConnections">,
  closeStorage: () => Promise<void>,
  logger: Logger,
  { timeoutMs = 10_000, forceExit = (code: number) => process.exit(code) } = {},
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError("Shutdown timeout must be 1–60000 ms.");
  }
  let stopping: Promise<boolean> | undefined;
  let storageClosed: Promise<void> | undefined;
  const drainStorage = () => {
    if (!storageClosed) {
      try {
        storageClosed = closeStorage();
      } catch (error) {
        storageClosed = Promise.reject(error);
      }
    }
    return storageClosed;
  };

  return (reason: ShutdownReason): Promise<boolean> => {
    stopping ??= (async () => {
      logger("info", { event: "api.stopping", reason });
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        server.closeAllConnections();
        // Attempt cleanup even if HTTP never drained. The deadline is final.
        void drainStorage().catch(() => {});
        logger("error", { event: "api.shutdown_failed", reason: "timeout" });
        forceExit(1);
      }, timeoutMs);
      let failed = false;
      try {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (
                error &&
                (error as NodeJS.ErrnoException).code !==
                  "ERR_SERVER_NOT_RUNNING"
              )
                reject(error);
              else resolve();
            });
          });
        } catch {
          failed = true;
        }
        try {
          await drainStorage();
        } catch {
          failed = true;
        }
        if (!timedOut) {
          if (failed)
            logger("error", {
              event: "api.shutdown_failed",
              reason: "cleanup_failed",
            });
          else logger("info", { event: "api.stopped" });
        }
        return !failed && !timedOut;
      } finally {
        clearTimeout(deadline);
      }
    })();
    return stopping;
  };
}
