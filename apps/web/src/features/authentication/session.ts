/** Browser-only memory. Credentials and proofs never enter storage, URLs or logs. */
export type ApiRole =
  "INTERNAL_ADMIN" | "SALES_STAFF" | "CUSTOMER_ADMIN" | "CUSTOMER_USER";
export interface SessionUser {
  id: string;
  companyId: string | null;
  displayName: string;
  role: ApiRole;
  mustChangePassword: boolean;
}
interface Tokens {
  user: SessionUser;
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  refreshExpiresAt: string;
}
export class AuthError extends Error {
  readonly code:
    | "invalid"
    | "credentials"
    | "session"
    | "restricted"
    | "rate"
    | "proof"
    | "conflict"
    | "unavailable";
  readonly retryAfter?: number;
  constructor(code: AuthError["code"], retryAfter?: number) {
    super("Account access could not be completed.");
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(v);
const apiRoles: ApiRole[] = [
  "INTERNAL_ADMIN",
  "SALES_STAFF",
  "CUSTOMER_ADMIN",
  "CUSTOMER_USER",
];
function validUser(v: unknown): v is SessionUser {
  if (
    !record(v) ||
    !uuid(v.id) ||
    !apiRoles.includes(v.role as ApiRole) ||
    typeof v.mustChangePassword !== "boolean"
  )
    return false;
  return v.role === "CUSTOMER_ADMIN" || v.role === "CUSTOMER_USER"
    ? uuid(v.companyId)
    : v.companyId === null;
}
function tokens(value: unknown, now: number): Tokens {
  if (
    !record(value) ||
    !validUser(value.user) ||
    !record(value.user) ||
    typeof value.user.displayName !== "string" ||
    !value.user.displayName.trim() ||
    value.user.displayName.length > 160 ||
    value.tokenType !== "Bearer"
  )
    throw new AuthError("unavailable");
  for (const key of ["accessToken", "refreshToken"] as const)
    if (
      typeof value[key] !== "string" ||
      !value[key].length ||
      value[key].length > 8192 ||
      /\s/.test(value[key])
    )
      throw new AuthError("unavailable");
  const expiry =
    typeof value.refreshExpiresAt === "string"
      ? Date.parse(value.refreshExpiresAt)
      : NaN;
  if (
    !Number.isInteger(value.expiresIn) ||
    (value.expiresIn as number) <= 0 ||
    (value.expiresIn as number) > 900 ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    expiry > now + 604800000 + 5000
  )
    throw new AuthError("unavailable");
  return {
    user: {
      id: value.user.id,
      companyId: value.user.companyId,
      displayName: value.user.displayName,
      role: value.user.role,
      mustChangePassword: value.user.mustChangePassword,
    },
    accessToken: value.accessToken as string,
    refreshToken: value.refreshToken as string,
    tokenType: "Bearer",
    expiresIn: value.expiresIn as number,
    refreshExpiresAt: value.refreshExpiresAt as string,
  };
}
export class SessionClient {
  #notice:
    | "password-changed"
    | "password-uncertain"
    | "session-ended"
    | "logged-out"
    | "logout-uncertain"
    | null = null;
  get notice() {
    return this.#notice;
  }
  #logout: Promise<void> | null = null;
  #proof: Tokens | null = null;
  #user: SessionUser | null = null;
  #started = false;
  get requiresLogin() {
    return this.#started && !this.#user;
  }
  #accessExpires = 0;
  #epoch = 0;
  #refresh: Promise<void> | null = null;
  #listeners = new Set<() => void>();
  #send: typeof fetch;
  #now: () => number;
  constructor(send: typeof fetch = fetch, now = Date.now) {
    this.#send = (input, init) => send.call(globalThis, input, init);
    this.#now = now;
  }
  snapshot = () => this.#user;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  clear = (notice: SessionClient["notice"] = null) => {
    this.#epoch++;
    this.#proof = null;
    this.#user = null;
    this.#accessExpires = 0;
    this.#refresh = null;
    this.#logout = null;
    this.#notice = notice;
    for (const listener of this.#listeners) listener();
  };
  async #json(
    path: string,
    init: RequestInit,
    expectedStatus = 200,
  ): Promise<unknown> {
    try {
      const response = await this.#send(`/api/v1/auth/${path}`, {
        ...init,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...(init.signal ? [init.signal] : []),
        ]),
      });
      if (response.status !== expectedStatus) {
        let errorCode: unknown;
        if (
          /^application\/json(?:;|$)/i.test(
            response.headers.get("content-type") ?? "",
          )
        ) {
          try {
            const body: unknown = await response.json();
            if (record(body) && record(body.error)) errorCode = body.error.code;
          } catch {
            /* Never expose an invalid error body. */
          }
        }
        const rawRetry = response.headers.get("retry-after") ?? "",
          retryAfter =
            /^\d{1,4}$/.test(rawRetry) &&
            Number(rawRetry) > 0 &&
            Number(rawRetry) <= 3600
              ? Number(rawRetry)
              : undefined;
        throw new AuthError(
          response.status === 401
            ? path === "reset-password"
              ? "proof"
              : path === "login" || errorCode === "INVALID_CREDENTIALS"
                ? "credentials"
                : "session"
            : response.status === 403 &&
                errorCode === "PASSWORD_CHANGE_REQUIRED"
              ? "restricted"
              : response.status === 409
                ? "conflict"
                : response.status === 400 ||
                    response.status === 413 ||
                    response.status === 415
                  ? "invalid"
                  : response.status === 429
                    ? "rate"
                    : "unavailable",
          retryAfter,
        );
      }
      if (
        !/^application\/json(?:;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw new AuthError("unavailable");
      const body: unknown = await response.json();
      if (
        !record(body) ||
        body.success !== true ||
        !uuid(body.requestId) ||
        !record(body.data)
      )
        throw new AuthError("unavailable");
      return body.data;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError("unavailable");
    }
  }
  async #access(allowRestricted: boolean): Promise<Tokens> {
    if (
      !this.#proof ||
      (!allowRestricted && this.#proof.user.mustChangePassword)
    )
      throw new AuthError(this.#proof ? "restricted" : "session");
    if (this.#now() >= this.#accessExpires) await this.refresh();
    if (
      !this.#proof ||
      (!allowRestricted && this.#proof.user.mustChangePassword)
    )
      throw new AuthError("session");
    return this.#proof;
  }
  async changeInitialPassword(
    currentPassword: string,
    newPassword: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#proof?.user.mustChangePassword)
      throw new AuthError("restricted");
    const epoch = this.#epoch;
    try {
      const proof = await this.#access(true);
      const data = await this.#json("change-password", {
        method: "POST",
        headers: { Authorization: `Bearer ${proof.accessToken}` },
        body: JSON.stringify({ currentPassword, newPassword }),
        signal,
      });
      if (epoch !== this.#epoch) throw new AuthError("session");
      if (!record(data) || data.requiresLogin !== true)
        throw new AuthError("unavailable");
      this.clear("password-changed");
    } catch (error) {
      if (
        epoch === this.#epoch &&
        error instanceof AuthError &&
        ["session", "conflict", "unavailable"].includes(error.code)
      )
        this.clear(
          error.code === "unavailable" ? "password-uncertain" : "session-ended",
        );
      throw error;
    }
  }
  async requestRecovery(email: string, signal?: AbortSignal): Promise<void> {
    const data = await this.#json(
      "forgot-password",
      { method: "POST", body: JSON.stringify({ email }), signal },
      202,
    );
    if (!record(data) || data.received !== true)
      throw new AuthError("unavailable");
  }
  async redeemRecovery(
    token: string,
    newPassword: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const epoch = this.#epoch;
    try {
      const data = await this.#json("reset-password", {
        method: "POST",
        body: JSON.stringify({ token, newPassword }),
        signal,
      });
      if (epoch !== this.#epoch) throw new AuthError("session");
      if (!record(data) || data.requiresLogin !== true)
        throw new AuthError("unavailable");
      this.clear("password-changed");
    } catch (error) {
      if (
        epoch === this.#epoch &&
        error instanceof AuthError &&
        error.code === "unavailable"
      )
        this.clear("password-uncertain");
      throw error;
    }
  }
  async logout(signal?: AbortSignal): Promise<void> {
    if (this.#logout) return this.#logout;
    const epoch = this.#epoch;
    const work = async () => {
      let confirmed = false;
      try {
        const proof = await this.#access(true);
        const data = await this.#json("logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${proof.accessToken}` },
          body: "{}",
          signal,
        });
        if (!record(data) || data.loggedOut !== true)
          throw new AuthError("unavailable");
        confirmed = true;
      } finally {
        if (epoch === this.#epoch)
          this.clear(confirmed ? "logged-out" : "logout-uncertain");
      }
    };
    const pending = work();
    this.#logout = pending;
    try {
      await pending;
    } finally {
      if (this.#logout === pending) this.#logout = null;
    }
  }
  async login(
    email: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<SessionUser> {
    this.clear();
    const epoch = this.#epoch,
      issuedAt = this.#now();
    const proof = tokens(
      await this.#json("login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
        signal,
      }),
      this.#now(),
    );
    if (!proof.user.mustChangePassword) {
      const current = await this.#json("me", {
        method: "GET",
        headers: { Authorization: `Bearer ${proof.accessToken}` },
        signal,
      });
      if (
        !record(current) ||
        !validUser(current.user) ||
        current.user.id !== proof.user.id ||
        current.user.role !== proof.user.role ||
        current.user.companyId !== proof.user.companyId ||
        current.user.mustChangePassword
      )
        throw new AuthError("session");
    }
    if (epoch !== this.#epoch || signal?.aborted)
      throw new AuthError("session");
    this.#proof = proof;
    this.#started = true;
    this.#user = proof.user;
    this.#accessExpires = Math.min(
      issuedAt + proof.expiresIn * 1000,
      Date.parse(proof.refreshExpiresAt),
    );
    for (const listener of this.#listeners) listener();
    return proof.user;
  }
  async refresh(): Promise<void> {
    if (this.#refresh) return this.#refresh;
    const previous = this.#proof,
      epoch = this.#epoch,
      issuedAt = this.#now();
    if (!previous || Date.parse(previous.refreshExpiresAt) <= this.#now()) {
      this.clear();
      throw new AuthError("session");
    }
    const work = async () => {
      try {
        const next = tokens(
          await this.#json("refresh", {
            method: "POST",
            body: JSON.stringify({ refreshToken: previous.refreshToken }),
          }),
          this.#now(),
        );
        if (epoch !== this.#epoch) throw new AuthError("session");
        if (
          next.user.id !== previous.user.id ||
          next.user.companyId !== previous.user.companyId ||
          next.user.role !== previous.user.role ||
          next.user.mustChangePassword !== previous.user.mustChangePassword ||
          next.refreshExpiresAt !== previous.refreshExpiresAt
        )
          throw new AuthError("session");
        this.#proof = next;
        this.#user = next.user;
        this.#accessExpires = Math.min(
          issuedAt + next.expiresIn * 1000,
          Date.parse(next.refreshExpiresAt),
        );
        for (const listener of this.#listeners) listener();
      } catch (error) {
        if (epoch === this.#epoch) this.clear();
        throw error;
      }
    };
    const pending = work();
    this.#refresh = pending;
    try {
      await pending;
    } finally {
      if (this.#refresh === pending) this.#refresh = null;
    }
  }
  /** GET-only business reads: mutation retry/idempotency stays with its feature. */
  async read(path: string, signal?: AbortSignal): Promise<Response> {
    return this.request(path, { method: "GET", signal });
  }
  /** Normal-access resource operation; refresh before admission, never replay a write. */
  async request(
    path: string,
    init: {
      method: "GET" | "POST" | "PATCH" | "DELETE";
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    if (this.#logout) throw new AuthError("session");
    if (
      !["GET", "POST", "PATCH", "DELETE"].includes(init.method) ||
      (init.method === "GET" && init.body !== undefined) ||
      !path.startsWith("/api/v1/") ||
      path.startsWith("/api/v1/auth/") ||
      /[?#]/.test(path.split("?")[0]) ||
      path.includes("\\") ||
      path.includes("..")
    )
      throw new AuthError("invalid");
    if (!this.#proof || this.#proof.user.mustChangePassword)
      throw new AuthError(this.#proof ? "restricted" : "session");
    if (this.#now() >= this.#accessExpires) await this.refresh();
    const proof = this.#proof,
      epoch = this.#epoch;
    if (!proof || proof.user.mustChangePassword) throw new AuthError("session");
    try {
      const response = await this.#send(path, {
        method: init.method,
        ...(init.body === undefined ? {} : { body: init.body }),
        headers: {
          Authorization: `Bearer ${proof.accessToken}`,
          Accept: "application/json",
          ...(init.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...(init.signal ? [init.signal] : []),
        ]),
      });
      if (epoch !== this.#epoch) throw new AuthError("session");
      if (response.status === 401) {
        this.clear();
        throw new AuthError("session");
      }
      return response;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError("unavailable");
    }
  }
}
