import { CatalogError } from "./api";
export type ResourceState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; error: CatalogError };
/** One screen's transient resource; cancels obsolete work and rejects late results. */
export class CatalogResource<T> {
  #state: ResourceState<T> = { kind: "loading" };
  #controller: AbortController | null = null;
  #version = 0;
  #listeners = new Set<() => void>();
  snapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #publish(state: ResourceState<T>) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
  cancel = () => {
    this.#version++;
    this.#controller?.abort();
    this.#controller = null;
  };
  async load(loader: (signal: AbortSignal) => Promise<T>) {
    this.cancel();
    const version = this.#version,
      controller = new AbortController();
    this.#controller = controller;
    this.#publish({ kind: "loading" });
    try {
      const data = await loader(controller.signal);
      if (version === this.#version && !controller.signal.aborted)
        this.#publish({ kind: "ready", data });
    } catch (error) {
      if (version === this.#version && !controller.signal.aborted)
        this.#publish({
          kind: "error",
          error:
            error instanceof CatalogError
              ? error
              : new CatalogError("unavailable"),
        });
    }
  }
}
