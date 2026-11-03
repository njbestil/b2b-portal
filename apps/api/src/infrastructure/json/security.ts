import { resolve, join } from "node:path";
import { lstat } from "node:fs/promises";
import { SessionError } from "../../services/session-state.js";
import { JsonFileStore } from "./store.js";

/** One injected coordinator per trusted directory/process. Future credential and
 * account writers must share run(), and read current state inside the operation.
 * Offline seed/reset/catalog swaps require the API and all writers stopped.
 */
export class JsonSecurityCoordinator {
  readonly directory: string;
  readonly store: JsonFileStore;
  private queue: Promise<void> = Promise.resolve();
  constructor(directory: string) {
    this.directory = resolve(directory);
    this.store = new JsonFileStore(this.directory);
  }
  async run<T>(
    operation: () => Promise<T>,
    reviewRecovery = false,
  ): Promise<T> {
    const result = this.queue.then(async () => {
      if (!reviewRecovery) {
        try {
          await lstat(join(this.directory, "application_review_intent.json"));
          throw new SessionError("unavailable");
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ))
            throw new SessionError("unavailable");
        }
      }
      return operation();
    });
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
