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
export type ProcessingState = {
  title: string;
  message: string;
  tone: "neutral" | "success" | "info" | "warning" | "danger";
};
const business = [
  "PENDING_CUSTOMER_CONFIRMATION",
  "SUBMITTED",
  "CONFIRMED",
  "FULFILLING",
  "DELIVERED",
  "CANCELLED",
  "REJECTED",
];
const technical = [
  "NOT_SENT",
  "PENDING",
  "PROCESSING",
  "SUCCESS",
  "FAILED",
  "RETRYING",
];
/** Fixed customer vocabulary. Never interpolate a provider error or technical state. */
export function processingState(
  status: unknown,
  integration: unknown,
): ProcessingState {
  if (
    !business.includes(status as string) ||
    !technical.includes(integration as string)
  )
    throw new RemoteError("unavailable");
  if (status === "DELIVERED")
    return {
      title: "Delivered",
      message: "This order has been delivered.",
      tone: "success",
    };
  if (status === "CANCELLED")
    return {
      title: "Cancelled",
      message: "This order has been cancelled.",
      tone: "neutral",
    };
  if (status === "REJECTED")
    return {
      title: "Order not accepted",
      message: "Contact your sales team for help with this order.",
      tone: "danger",
    };
  if (status === "FULFILLING")
    return {
      title: "Preparing delivery",
      message: "Your order is being prepared for delivery.",
      tone: "info",
    };
  if (status === "CONFIRMED")
    return {
      title: "Confirmed",
      message: "Your order has been confirmed.",
      tone: "success",
    };
  if (status === "PENDING_CUSTOMER_CONFIRMATION")
    return {
      title: "Awaiting your confirmation",
      message: "This order needs customer confirmation before it can proceed.",
      tone: "warning",
    };
  if (integration === "FAILED")
    return {
      title: "Processing delayed",
      message:
        "Your order remains submitted. Contact your sales team before placing it again.",
      tone: "warning",
    };
  if (integration === "SUCCESS")
    return {
      title: "Order submitted",
      message:
        "Your order has been received. Check its status for further updates.",
      tone: "info",
    };
  return {
    title: "Order processing",
    message:
      "Your order is submitted and awaiting further updates. Check its status before placing it again.",
    tone: "info",
  };
}
export type ProcessingOrder = {
  id: string;
  number: string;
  createdAt: string;
  state: ProcessingState;
};
export interface ProcessingAdapter {
  list(
    offset: number,
    signal: AbortSignal,
  ): Promise<{ items: ProcessingOrder[]; total: number }>;
}
export function processingOrder(
  value: unknown,
  companyId: string,
): ProcessingOrder {
  if (
    !object(value) ||
    !entityId(value.id) ||
    value.companyId !== companyId ||
    !timestamp(value.createdAt) ||
    !(value.orderNumber === null || safeText(value.orderNumber, 256))
  )
    throw new RemoteError("unavailable");
  return {
    id: value.id,
    number: value.orderNumber ?? "Submitted order",
    createdAt: value.createdAt,
    state: processingState(value.status, value.integrationStatus),
  };
}
export class ProcessingClient implements ProcessingAdapter {
  constructor(
    private readonly session: SessionClient,
    private readonly user: SessionUser,
  ) {}
  async list(offset: number, signal: AbortSignal) {
    if (
      this.user.mustChangePassword ||
      !entityId(this.user.companyId) ||
      !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(this.user.role)
    )
      throw new RemoteError("forbidden");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      throw new RemoteError("invalid");
    try {
      const response = await this.session.request(
        `/api/v1/companies/${this.user.companyId}/order-history?offset=${offset}&limit=20`,
        { method: "GET", signal },
      );
      if (!response.ok)
        throw new RemoteError(
          response.status === 401
            ? "session"
            : response.status === 403
              ? "forbidden"
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
        !object(body.data) ||
        !Array.isArray(body.data.items) ||
        body.data.items.length > 20 ||
        !Number.isSafeInteger(body.data.total) ||
        (body.data.total as number) < 0 ||
        body.data.offset !== offset ||
        body.data.limit !== 20
      )
        throw new RemoteError("unavailable");
      const items = body.data.items.map((v) =>
        processingOrder(v, this.user.companyId!),
      );
      if (
        new Set(items.map((v) => v.id)).size !== items.length ||
        items.length > (body.data.total as number)
      )
        throw new RemoteError("unavailable");
      return { items, total: body.data.total as number };
    } catch (e) {
      if (e instanceof RemoteError) throw e;
      if (e instanceof AuthError && ["session", "restricted"].includes(e.code))
        throw new RemoteError("session");
      throw new RemoteError("unavailable");
    }
  }
}
