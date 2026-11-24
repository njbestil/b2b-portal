import {
  AuthError,
  type SessionClient,
  type SessionUser,
} from "../authentication/session";
import {
  entityId,
  object,
  RemoteError,
  safeText,
  timestamp,
} from "../../shared/remote";
export type Cancellation = {
  requestId: string;
  orderId: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
};
export type CancellationOrder = { id: string; number: string; status: string };
const statuses = [
  "DRAFT",
  "PENDING_CUSTOMER_CONFIRMATION",
  "SUBMITTED",
  "CONFIRMED",
  "FULFILLING",
  "DELIVERED",
  "CANCELLED",
  "REJECTED",
];
export function cancellationReason(value: string) {
  const result = value.trim();
  if (
    !result ||
    result.length > 500 ||
    Array.from(result).some((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || (n >= 127 && n <= 159) || (n >= 0xd800 && n <= 0xdfff);
    })
  )
    throw new RemoteError("invalid");
  return result;
}
export function cancellationView(
  value: unknown,
  orderId: string,
): Cancellation | null {
  if (value === null) return null;
  if (
    !object(value) ||
    !entityId(value.requestId) ||
    value.orderId !== orderId ||
    !["PENDING", "APPROVED", "REJECTED"].includes(value.status as string)
  )
    throw new RemoteError("unavailable");
  return {
    requestId: value.requestId,
    orderId,
    status: value.status as Cancellation["status"],
  };
}
export function cancellationMessage(status: Cancellation["status"]) {
  if (status === "APPROVED")
    return {
      title: "Cancellation approved",
      message: "Your cancellation request was approved.",
      tone: "success" as const,
    };
  if (status === "REJECTED")
    return {
      title: "Cancellation rejected",
      message:
        "Your request was not approved. The request has not cancelled your order.",
      tone: "danger" as const,
    };
  return {
    title: "Cancellation requested",
    message:
      "A decision is pending. Your order is not cancelled by this request yet. Check status for an update.",
    tone: "warning" as const,
  };
}
export class CancellationClient {
  constructor(
    private session: SessionClient,
    private user: SessionUser,
  ) {}
  private async read(
    path: string,
    method: "GET" | "POST",
    signal: AbortSignal,
    body?: unknown,
    key?: string,
  ) {
    if (
      this.user.mustChangePassword ||
      !entityId(this.user.companyId) ||
      !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(this.user.role)
    )
      throw new RemoteError("forbidden");
    try {
      const response = await this.session.request(path, {
        method,
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(key ? { idempotencyKey: key } : {}),
      });
      if (response.status !== (method === "POST" ? 202 : 200))
        throw new RemoteError(
          response.status === 400
            ? "invalid"
            : response.status === 401
              ? "session"
              : response.status === 403
                ? "forbidden"
                : response.status === 404
                  ? "not-found"
                  : response.status === 409
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
      const value: unknown = await response.json();
      if (
        !object(value) ||
        value.success !== true ||
        !entityId(value.requestId) ||
        !object(value.data)
      )
        throw new RemoteError("unavailable");
      return value.data;
    } catch (e) {
      if (e instanceof RemoteError) throw e;
      if (e instanceof AuthError && ["session", "restricted"].includes(e.code))
        throw new RemoteError("session");
      throw new RemoteError("unavailable");
    }
  }
  async orders(offset: number, signal: AbortSignal) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      throw new RemoteError("invalid");
    const data = await this.read(
      "/api/v1/companies/" +
        this.user.companyId +
        "/orders?offset=" +
        offset +
        "&limit=20",
      "GET",
      signal,
    );
    if (
      !Array.isArray(data.items) ||
      data.items.length > 20 ||
      !Number.isSafeInteger(data.total) ||
      (data.total as number) < 0
    )
      throw new RemoteError("unavailable");
    const items = data.items.map((r): CancellationOrder => {
      if (
        !object(r) ||
        !entityId(r.id) ||
        r.companyId !== this.user.companyId ||
        !statuses.includes(r.status as string) ||
        !(r.orderNumber === null || safeText(r.orderNumber, 256)) ||
        !timestamp(r.createdAt)
      )
        throw new RemoteError("unavailable");
      return {
        id: r.id,
        number: r.orderNumber ?? "Order " + r.id.slice(-8),
        status: r.status as string,
      };
    });
    if (
      new Set(items.map((r) => r.id)).size !== items.length ||
      items.length > (data.total as number)
    )
      throw new RemoteError("unavailable");
    return { items, total: data.total as number };
  }
  private path(id: string) {
    if (!entityId(id)) throw new RemoteError("invalid");
    return (
      "/api/v1/companies/" +
      this.user.companyId +
      "/orders/" +
      id +
      "/cancellations"
    );
  }
  async latest(id: string, signal: AbortSignal) {
    return {
      cancellation: cancellationView(
        (await this.read(this.path(id), "GET", signal)).cancellation,
        id,
      ),
    };
  }
  async submit(id: string, reason: string, key: string, signal: AbortSignal) {
    if (!entityId(key)) throw new RemoteError("invalid");
    const value = await this.read(
      this.path(id),
      "POST",
      signal,
      { reason: cancellationReason(reason) },
      key,
    );
    const cancellation = cancellationView(value, id);
    if (!cancellation) throw new RemoteError("unavailable");
    return { cancellation };
  }
}
