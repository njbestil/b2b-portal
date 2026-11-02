export class RemoteError extends Error {
  readonly code:
    | "invalid"
    | "session"
    | "forbidden"
    | "not-found"
    | "conflict"
    | "rate"
    | "unavailable";
  constructor(code: RemoteError["code"]) {
    super("The operation could not be confirmed.");
    this.code = code;
  }
}
export const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const entityId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(v);
export function safeText(
  value: unknown,
  limit: number,
  empty = false,
): value is string {
  return (
    typeof value === "string" &&
    (empty || !!value.trim()) &&
    value.length <= limit &&
    !Array.from(value).some((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || n === 127 || (n >= 0xd800 && n <= 0xdfff);
    })
  );
}
export const timestamp = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
export const unavailable = async (): Promise<never> => {
  throw new RemoteError("unavailable");
};
export function remoteMessage(error: RemoteError, mutation = false) {
  if (error.code === "session") return "Sign in again to continue.";
  if (error.code === "forbidden")
    return "This account is not allowed to perform this action.";
  if (error.code === "not-found")
    return "This record is unavailable in the authorized account scope.";
  if (error.code === "conflict")
    return "This record changed. Reload the latest details before trying again.";
  if (error.code === "invalid") return "Check the entered details.";
  if (error.code === "rate")
    return "Too many attempts. Wait before trying again.";
  return mutation
    ? "The result could not be confirmed. The server may have saved it. Reload the latest details before another action."
    : "This information is unavailable. Please try again later.";
}
export type RemoteState<T> = {
  data: T | null;
  busy: boolean;
  error: RemoteError | null;
  needsReload: boolean;
  saved: boolean;
};
/** Per-screen state. Never optimistically saves, retries writes, or publishes late results. */
export class RemoteModel<T> {
  #state: RemoteState<T> = {
    data: null,
    busy: true,
    error: null,
    needsReload: false,
    saved: false,
  };
  #listeners = new Set<() => void>();
  #controller: AbortController | null = null;
  #version = 0;
  #writing = false;
  snapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #publish(state: RemoteState<T>) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
  cancel = () => {
    this.#version++;
    this.#controller?.abort();
    this.#controller = null;
    this.#writing = false;
  };
  async load(read: (signal: AbortSignal) => Promise<T>) {
    if (this.#writing) return;
    this.cancel();
    const version = this.#version,
      controller = new AbortController();
    this.#controller = controller;
    this.#publish({
      data: null,
      busy: true,
      error: null,
      needsReload: false,
      saved: false,
    });
    try {
      const data = await read(controller.signal);
      if (version === this.#version && !controller.signal.aborted)
        this.#publish({
          data,
          busy: false,
          error: null,
          needsReload: false,
          saved: false,
        });
    } catch (error) {
      if (version === this.#version && !controller.signal.aborted)
        this.#publish({
          data: null,
          busy: false,
          error:
            error instanceof RemoteError
              ? error
              : new RemoteError("unavailable"),
          needsReload: false,
          saved: false,
        });
    }
  }
  async write(
    change: (data: T, signal: AbortSignal) => Promise<T>,
  ): Promise<boolean> {
    if (
      this.#state.busy ||
      !this.#state.data ||
      this.#state.needsReload ||
      this.#writing
    )
      return false;
    const data = this.#state.data,
      version = ++this.#version,
      controller = new AbortController();
    this.#controller?.abort();
    this.#controller = controller;
    this.#writing = true;
    this.#publish({
      data,
      busy: true,
      error: null,
      needsReload: false,
      saved: false,
    });
    try {
      const result = await change(data, controller.signal);
      if (version !== this.#version || controller.signal.aborted) return false;
      this.#publish({
        data: result,
        busy: false,
        error: null,
        needsReload: false,
        saved: true,
      });
      return true;
    } catch (error) {
      if (version === this.#version && !controller.signal.aborted)
        this.#publish({
          data,
          busy: false,
          error:
            error instanceof RemoteError
              ? error
              : new RemoteError("unavailable"),
          needsReload: true,
          saved: false,
        });
      return false;
    } finally {
      if (version === this.#version) this.#writing = false;
    }
  }
}
export interface ApiOperation {
  path: string;
  method: "GET" | "POST" | "PATCH";
  body?: unknown;
}
export type ApiTransport = (
  operation: ApiOperation,
  signal: AbortSignal,
) => Promise<unknown>;
/** Inject a normal authenticated requester; no public fetch or fixture fallback. */
export function createApiTransport(
  send: (
    path: string,
    init: {
      method: "GET" | "POST" | "PATCH";
      body?: string;
      signal: AbortSignal;
    },
  ) => Promise<Response>,
): ApiTransport {
  return async (operation, signal) => {
    if (
      !operation.path.startsWith("/api/v1/") ||
      operation.path.includes("..") ||
      operation.path.includes("\\") ||
      operation.path.includes("#")
    )
      throw new RemoteError("invalid");
    try {
      const response = await send(operation.path, {
        method: operation.method,
        ...(operation.body === undefined
          ? {}
          : { body: JSON.stringify(operation.body) }),
        signal,
      });
      if (!response.ok)
        throw new RemoteError(
          response.status === 400 ||
            response.status === 413 ||
            response.status === 415
            ? "invalid"
            : response.status === 401
              ? "session"
              : response.status === 403
                ? "forbidden"
                : response.status === 404
                  ? "not-found"
                  : response.status === 409 || response.status === 412
                    ? "conflict"
                    : response.status === 429
                      ? "rate"
                      : "unavailable",
        );
      if (
        !/^application\/json(?:;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw new RemoteError("unavailable");
      const body: unknown = await response.json();
      if (
        !object(body) ||
        body.success !== true ||
        !entityId(body.requestId) ||
        !object(body.data)
      )
        throw new RemoteError("unavailable");
      return body.data;
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError("unavailable");
    }
  };
}
