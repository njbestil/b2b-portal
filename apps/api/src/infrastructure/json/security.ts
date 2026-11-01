import { resolve } from "node:path";
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
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
