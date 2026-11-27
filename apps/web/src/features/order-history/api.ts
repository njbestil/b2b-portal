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
  type ApiTransport,
} from "../../shared/remote";
import { processingState, type ProcessingState } from "../order-processing/api";
export const historyStatuses = [
  "PENDING_CUSTOMER_CONFIRMATION",
  "SUBMITTED",
  "CONFIRMED",
  "FULFILLING",
  "DELIVERED",
  "CANCELLED",
  "REJECTED",
] as const;
export const statusNames: Record<string, string> = {
  PENDING_CUSTOMER_CONFIRMATION: "Pending confirmation",
  SUBMITTED: "Submitted",
  CONFIRMED: "Confirmed",
  FULFILLING: "Fulfilling",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  REJECTED: "Rejected",
};
export type HistoryFilters = {
  search: string;
  status: string;
  from: string;
  to: string;
};
export const emptyFilters: HistoryFilters = {
  search: "",
  status: "all",
  from: "",
  to: "",
};
export function historyQuery(filters: HistoryFilters, offset: number) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100000 ||
    !safeText(filters.search, 128, true) ||
    Array.from(filters.search).some((c) => {
      const n = c.codePointAt(0)!;
      return n >= 127 && n <= 159;
    }) ||
    !(
      filters.status === "all" ||
      historyStatuses.includes(
        filters.status as (typeof historyStatuses)[number],
      )
    )
  )
    throw new RemoteError("invalid");
  for (const date of [filters.from, filters.to])
    if (
      date &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        date < "0001-01-01" ||
        date > "9999-12-30" ||
        !Number.isFinite(Date.parse(date + "T00:00:00Z")) ||
        new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date)
    )
      throw new RemoteError("invalid");
  if (filters.from && filters.to && filters.from > filters.to)
    throw new RemoteError("invalid");
  const q = new URLSearchParams({ offset: String(offset), limit: "20" });
  for (const [k, v] of Object.entries(filters))
    if (v && !(k === "status" && v === "all")) q.set(k, v);
  return q.toString();
}
export type HistoryOrder = {
  id: string;
  number: string;
  createdAt: string;
  status: string;
  state: ProcessingState;
};
export type HistorySnapshot = {
  submittedAt: string;
  submittedBy: string;
  delivery: {
    label: string;
    line1: string;
    contactName: string | null;
    contactPhone: string | null;
  };
  currency: string;
  total: string;
  items: {
    id: string;
    sku: string;
    name: string;
    uom: string;
    moq: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
  }[];
};
export type HistoryDetail = HistoryOrder & { snapshot: HistorySnapshot | null };
export function historyOrder(value: unknown, company: string): HistoryOrder {
  if (
    !object(value) ||
    !entityId(value.id) ||
    value.companyId !== company ||
    !timestamp(value.createdAt) ||
    !(value.orderNumber === null || safeText(value.orderNumber, 256)) ||
    !historyStatuses.includes(value.status as (typeof historyStatuses)[number])
  )
    throw new RemoteError("unavailable");
  return {
    id: value.id,
    number: value.orderNumber ?? "Order " + value.id.slice(-8),
    createdAt: value.createdAt,
    status: value.status as string,
    state: processingState(value.status, value.integrationStatus),
  };
}
const decimal = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 256 &&
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v);
export function historySnapshot(v: unknown): HistorySnapshot | null {
  if (v === null) return null;
  if (
    !object(v) ||
    !timestamp(v.submittedAt) ||
    !object(v.submittedBy) ||
    !safeText(v.submittedBy.displayName, 160) ||
    !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(
      v.submittedBy.role as string,
    ) ||
    !object(v.delivery) ||
    !safeText(v.delivery.label, 160) ||
    !safeText(v.delivery.line1, 500) ||
    !(
      v.delivery.contactName === null || safeText(v.delivery.contactName, 160)
    ) ||
    !(
      v.delivery.contactPhone === null || safeText(v.delivery.contactPhone, 40)
    ) ||
    typeof v.currency !== "string" ||
    !/^[A-Z]{3}$/.test(v.currency) ||
    !decimal(v.total) ||
    !Array.isArray(v.items) ||
    v.items.length < 1 ||
    v.items.length > 100
  )
    throw new RemoteError("unavailable");
  const items = v.items.map((r: unknown) => {
    if (
      !object(r) ||
      !entityId(r.itemId) ||
      !entityId(r.productId) ||
      !safeText(r.sku, 128) ||
      !safeText(r.name, 256) ||
      !safeText(r.sellingUom, 256) ||
      !decimal(r.minimumOrderQuantity) ||
      !/[1-9]/.test(r.minimumOrderQuantity) ||
      !decimal(r.quantity) ||
      !/[1-9]/.test(r.quantity) ||
      !decimal(r.unitPrice) ||
      !decimal(r.lineTotal) ||
      r.currency !== v.currency
    )
      throw new RemoteError("unavailable");
    return {
      id: r.itemId,
      sku: r.sku,
      name: r.name,
      uom: r.sellingUom,
      moq: r.minimumOrderQuantity,
      quantity: r.quantity,
      unitPrice: r.unitPrice,
      lineTotal: r.lineTotal,
    };
  });
  if (new Set(items.map((r) => r.id)).size !== items.length)
    throw new RemoteError("unavailable");
  return {
    submittedAt: v.submittedAt,
    submittedBy: v.submittedBy.displayName,
    delivery: {
      label: v.delivery.label,
      line1: v.delivery.line1,
      contactName: v.delivery.contactName,
      contactPhone: v.delivery.contactPhone,
    },
    currency: v.currency,
    total: v.total,
    items,
  };
}
export class HistoryClient {
  private transport: ApiTransport;
  constructor(
    session: SessionClient,
    private user: SessionUser,
  ) {
    this.transport = createApiTransport(async (path, init) => {
      try {
        return await session.request(path, init);
      } catch (e) {
        if (
          e instanceof AuthError &&
          ["session", "restricted"].includes(e.code)
        )
          throw new RemoteError("session");
        throw e;
      }
    });
  }
  private read(path: string, signal: AbortSignal, body?: unknown) {
    if (
      this.user.mustChangePassword ||
      !entityId(this.user.companyId) ||
      !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(this.user.role)
    )
      throw new RemoteError("forbidden");
    return this.transport(
      {
        path,
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body }),
      },
      signal,
    );
  }
  async list(filters: HistoryFilters, offset: number, signal: AbortSignal) {
    const data = await this.read(
      "/api/v1/companies/" +
        this.user.companyId +
        "/order-history?" +
        historyQuery(filters, offset),
      signal,
    );
    if (
      !object(data) ||
      !Array.isArray(data.items) ||
      data.items.length > 20 ||
      !Number.isSafeInteger(data.total) ||
      (data.total as number) < data.items.length ||
      data.offset !== offset ||
      data.limit !== 20
    )
      throw new RemoteError("unavailable");
    const items = data.items.map((v) => historyOrder(v, this.user.companyId!));
    if (new Set(items.map((r) => r.id)).size !== items.length)
      throw new RemoteError("unavailable");
    return { items, total: data.total as number };
  }
  async find(id: string, signal: AbortSignal) {
    if (!entityId(id)) throw new RemoteError("invalid");
    const data = await this.read(
      "/api/v1/companies/" + this.user.companyId + "/order-history/" + id,
      signal,
    );
    if (!object(data)) throw new RemoteError("unavailable");
    const order = historyOrder(data.order, this.user.companyId!);
    if (order.id !== id || !object(data.order))
      throw new RemoteError("unavailable");
    return {
      order: { ...order, snapshot: historySnapshot(data.order.snapshot) },
    };
  }
  async reorder(id: string, signal: AbortSignal) {
    if (!entityId(id)) throw new RemoteError("invalid");
    const data = await this.read(
      "/api/v1/orders/" + id + "/reorder",
      signal,
      {},
    );
    if (
      !object(data) ||
      !object(data.draft) ||
      !entityId(data.draft.id) ||
      data.draft.companyId !== this.user.companyId ||
      data.draft.createdByUserId !== this.user.id ||
      data.draft.status !== "DRAFT" ||
      data.draft.integrationStatus !== "NOT_SENT"
    )
      throw new RemoteError("unavailable");
    return data.draft.id;
  }
}
