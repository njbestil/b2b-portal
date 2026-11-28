import {
  AuthError,
  type SessionClient,
  type SessionUser,
} from "../authentication/session";
import {
  createApiTransport,
  entityId,
  object,
  RemoteError,
  safeText,
  timestamp,
} from "../../shared/remote";
import { quantity } from "../order-drafts/api";
export type Review = {
  canSubmit?: boolean;
  confirmation: {
    id: string;
    orderId: string;
    customerUserId: string;
    status: "PENDING" | "CONFIRMED" | "REJECTED";
    createdAt: string;
    decidedAt?: string;
    reason?: string | null;
  };
  order: {
    id: string;
    status:
      | "PENDING_CUSTOMER_CONFIRMATION"
      | "REJECTED"
      | "SUBMITTED"
      | "CONFIRMED"
      | "FULFILLING"
      | "DELIVERED"
      | "CANCELLED";
    createdBy: string;
    items: {
      id: string;
      productId: string;
      quantity: string;
      name: string;
      sku: string;
      sellingUom: string;
    }[];
    delivery: { label: string; line1: string } | null;
  };
};
export function reviewView(value: unknown, id: string): Review {
  if (!object(value) || !object(value.confirmation) || !object(value.order))
    throw new RemoteError("unavailable");
  const c = value.confirmation,
    o = value.order;
  if (
    !entityId(c.id) ||
    c.orderId !== id ||
    !entityId(c.customerUserId) ||
    !timestamp(c.createdAt) ||
    !["PENDING", "CONFIRMED", "REJECTED"].includes(c.status as string) ||
    o.id !== id ||
    !(
      c.status === "CONFIRMED"
        ? [
            "PENDING_CUSTOMER_CONFIRMATION",
            "SUBMITTED",
            "CONFIRMED",
            "FULFILLING",
            "DELIVERED",
            "CANCELLED",
            "REJECTED",
          ]
        : [
            c.status === "REJECTED"
              ? "REJECTED"
              : "PENDING_CUSTOMER_CONFIRMATION",
          ]
    ).includes(o.status as string) ||
    (value.canSubmit !== undefined && typeof value.canSubmit !== "boolean") ||
    (value.canSubmit === true &&
      (c.status !== "CONFIRMED" ||
        o.status !== "PENDING_CUSTOMER_CONFIRMATION")) ||
    !safeText(o.createdBy, 160) ||
    !Array.isArray(o.items) ||
    !o.items.length ||
    o.items.length > 100
  )
    throw new RemoteError("unavailable");
  const items = o.items.map((r) => {
    if (
      !object(r) ||
      !entityId(r.id) ||
      !entityId(r.productId) ||
      typeof r.quantity !== "string" ||
      !quantity(r.quantity) ||
      !safeText(r.name, 256) ||
      !safeText(r.sku, 256) ||
      !safeText(r.sellingUom, 64)
    )
      throw new RemoteError("unavailable");
    return {
      id: r.id,
      productId: r.productId,
      quantity: r.quantity,
      name: r.name,
      sku: r.sku,
      sellingUom: r.sellingUom,
    };
  });
  if (new Set(items.map((i) => i.id)).size !== items.length)
    throw new RemoteError("unavailable");
  if (
    o.delivery !== null &&
    (!object(o.delivery) ||
      !safeText(o.delivery.label, 160) ||
      !safeText(o.delivery.line1, 500))
  )
    throw new RemoteError("unavailable");
  if (
    c.status !== "PENDING" &&
    (!timestamp(c.decidedAt) ||
      Date.parse(c.decidedAt) <= Date.parse(c.createdAt) ||
      (c.status === "CONFIRMED" && c.reason !== null) ||
      (c.status === "REJECTED" && !safeText(c.reason, 1000)))
  )
    throw new RemoteError("unavailable");
  return {
    canSubmit: value.canSubmit === true,
    confirmation: {
      id: c.id,
      orderId: id,
      customerUserId: c.customerUserId,
      status: c.status as Review["confirmation"]["status"],
      createdAt: c.createdAt,
      ...(c.status === "PENDING"
        ? {}
        : {
            decidedAt: c.decidedAt as string,
            reason: c.reason as string | null,
          }),
    },
    order: {
      id,
      status: o.status as Review["order"]["status"],
      createdBy: o.createdBy,
      items,
      delivery: object(o.delivery)
        ? {
            label: o.delivery.label as string,
            line1: o.delivery.line1 as string,
          }
        : null,
    },
  };
}
export class ConfirmationClient {
  private readonly send;
  constructor(session: SessionClient, user: SessionUser) {
    if (
      user.mustChangePassword ||
      !entityId(user.companyId) ||
      !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(user.role)
    )
      throw new RemoteError("forbidden");
    this.send = createApiTransport(async (path, init) => {
      try {
        return await session.request(path, {
          ...init,
          ...(path.endsWith("/submit")
            ? { idempotencyKey: "assisted-confirmation" }
            : {}),
        });
      } catch (e) {
        throw new RemoteError(
          e instanceof AuthError && ["session", "restricted"].includes(e.code)
            ? "session"
            : "unavailable",
        );
      }
    });
  }
  async find(id: string, signal: AbortSignal) {
    if (!entityId(id)) throw new RemoteError("invalid");
    return reviewView(
      await this.send(
        { path: `/api/v1/orders/${id}/confirmation`, method: "GET" },
        signal,
      ),
      id,
    );
  }
  async quote(
    id: string,
    confirmationId: string,
    signal: AbortSignal,
  ): Promise<SubmissionQuote> {
    if (!entityId(id) || !entityId(confirmationId))
      throw new RemoteError("invalid");
    return submissionQuote(
      await this.send(
        {
          path: `/api/v1/orders/${id}/submission-quote`,
          method: "POST",
          body: { confirmationId },
        },
        signal,
      ),
      confirmationId,
    );
  }
  async submit(id: string, quote: SubmissionQuote, signal: AbortSignal) {
    if (!entityId(id)) throw new RemoteError("invalid");
    submissionQuote(quote, quote.confirmationId);
    const result = await this.send(
      {
        path: `/api/v1/order-drafts/${id}/submit`,
        method: "POST",
        body: { confirmationId: quote.confirmationId, quoteToken: quote.token },
      },
      signal,
    );
    if (!object(result) || result.orderId !== id)
      throw new RemoteError("unavailable");
  }
  async decide(
    id: string,
    confirmationId: string,
    decision: "CONFIRMED" | "REJECTED",
    reason: string | null,
    signal: AbortSignal,
  ) {
    if (
      !entityId(id) ||
      !entityId(confirmationId) ||
      !["CONFIRMED", "REJECTED"].includes(decision) ||
      (decision === "CONFIRMED" ? reason !== null : !safeText(reason, 1000))
    )
      throw new RemoteError("invalid");
    const result = reviewView(
      await this.send(
        {
          path: `/api/v1/orders/${id}/confirmation`,
          method: "POST",
          body: { confirmationId, decision, reason },
        },
        signal,
      ),
      id,
    );
    if (
      result.confirmation.id !== confirmationId ||
      result.confirmation.status !== decision
    )
      throw new RemoteError("unavailable");
    return result;
  }
}
export type SubmissionQuote = {
  delivery: {
    label: string;
    line1: string;
    contactName: string | null;
    contactPhone: string | null;
  };
  confirmationId: string;
  token: string;
  currency: string;
  total: string;
  items: {
    itemId: string;
    name: string;
    quantity: string;
    sellingUom: string;
    unitPrice: string;
    lineTotal: string;
    currency: string;
  }[];
};
const money = (v: unknown): v is string =>
  typeof v === "string" && /^\d{1,18}(?:\.\d{1,6})?$/.test(v);
export function submissionQuote(
  value: unknown,
  confirmationId: string,
): SubmissionQuote {
  if (
    !object(value) ||
    value.confirmationId !== confirmationId ||
    !entityId(confirmationId) ||
    typeof value.token !== "string" ||
    !/^assisted-[a-f0-9]{64}$/.test(value.token) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !money(value.total) ||
    !object(value.delivery) ||
    !safeText(value.delivery.label, 160) ||
    !safeText(value.delivery.line1, 500) ||
    !(
      value.delivery.contactName === null ||
      safeText(value.delivery.contactName, 160)
    ) ||
    !(
      value.delivery.contactPhone === null ||
      safeText(value.delivery.contactPhone, 40)
    ) ||
    !Array.isArray(value.items) ||
    !value.items.length ||
    value.items.length > 100
  )
    throw new RemoteError("unavailable");
  const items = value.items.map((r) => {
    if (
      !object(r) ||
      !entityId(r.itemId) ||
      !safeText(r.name, 256) ||
      !safeText(r.sellingUom, 64) ||
      typeof r.quantity !== "string" ||
      !quantity(r.quantity) ||
      !money(r.unitPrice) ||
      !money(r.lineTotal) ||
      r.currency !== value.currency
    )
      throw new RemoteError("unavailable");
    return {
      itemId: r.itemId,
      name: r.name,
      quantity: r.quantity,
      sellingUom: r.sellingUom,
      unitPrice: r.unitPrice,
      lineTotal: r.lineTotal,
      currency: r.currency as string,
    };
  });
  if (new Set(items.map((r) => r.itemId)).size !== items.length)
    throw new RemoteError("unavailable");
  return {
    confirmationId,
    token: value.token,
    currency: value.currency,
    total: value.total,
    delivery: {
      label: value.delivery.label as string,
      line1: value.delivery.line1 as string,
      contactName: value.delivery.contactName as string | null,
      contactPhone: value.delivery.contactPhone as string | null,
    },
    items,
  };
}
