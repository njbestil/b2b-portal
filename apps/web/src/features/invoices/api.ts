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
export type Invoice = {
  id: string;
  orderId: string;
  invoiceNumber: string;
  status: "available";
  amount: string;
  currency: string;
  issuedAt: string;
  syncedAt: string;
  documentAvailable: boolean;
};
export function invoiceView(value: unknown): Invoice {
  if (
    !object(value) ||
    !entityId(value.id) ||
    !entityId(value.orderId) ||
    !safeText(value.invoiceNumber, 256) ||
    value.status !== "available" ||
    typeof value.amount !== "string" ||
    !/^(?:0|[1-9]\d{0,23})(?:\.\d{1,18})?$/.test(value.amount) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !timestamp(value.issuedAt) ||
    !timestamp(value.syncedAt) ||
    typeof value.documentAvailable !== "boolean"
  )
    throw new RemoteError("unavailable");
  return {
    id: value.id,
    orderId: value.orderId,
    invoiceNumber: value.invoiceNumber,
    status: value.status,
    amount: value.amount,
    currency: value.currency,
    issuedAt: value.issuedAt,
    syncedAt: value.syncedAt,
    documentAvailable: value.documentAvailable,
  };
}
export interface InvoiceAdapter {
  list(
    offset: number,
    signal: AbortSignal,
  ): Promise<{ items: Invoice[]; total: number }>;
  find(id: string, signal: AbortSignal): Promise<Invoice>;
  download(
    id: string,
    signal: AbortSignal,
  ): Promise<{ text: string; filename: string }>;
}
export class InvoiceClient implements InvoiceAdapter {
  constructor(
    private readonly session: SessionClient,
    user: SessionUser,
  ) {
    if (
      user.mustChangePassword ||
      !entityId(user.companyId) ||
      !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(user.role)
    )
      throw new RemoteError("forbidden");
  }
  private async request(path: string, signal: AbortSignal) {
    try {
      return await this.session.read(path, signal);
    } catch (error) {
      throw new RemoteError(
        error instanceof AuthError &&
          ["session", "restricted"].includes(error.code)
          ? "session"
          : "unavailable",
      );
    }
  }
  private json(path: string, signal: AbortSignal) {
    return createApiTransport((p, init) => this.request(p, init.signal))(
      { path, method: "GET" },
      signal,
    );
  }
  async list(offset: number, signal: AbortSignal) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      throw new RemoteError("invalid");
    const value = await this.json(
      `/api/v1/invoices?offset=${offset}&limit=20`,
      signal,
    );
    if (
      !object(value) ||
      !Array.isArray(value.items) ||
      value.items.length > 20 ||
      value.offset !== offset ||
      value.limit !== 20 ||
      !Number.isSafeInteger(value.total) ||
      (value.total as number) < value.items.length
    )
      throw new RemoteError("unavailable");
    const items = value.items.map(invoiceView);
    if (new Set(items.map((v) => v.id)).size !== items.length)
      throw new RemoteError("unavailable");
    return { items, total: value.total as number };
  }
  async find(id: string, signal: AbortSignal) {
    if (!entityId(id)) throw new RemoteError("invalid");
    const value = invoiceView(
      await this.json(`/api/v1/invoices/${id}`, signal),
    );
    if (value.id !== id) throw new RemoteError("unavailable");
    return value;
  }
  async download(id: string, signal: AbortSignal) {
    if (!entityId(id)) throw new RemoteError("invalid");
    const response = await this.request(
      `/api/v1/invoices/${id}/document`,
      signal,
    );
    if (!response.ok)
      throw new RemoteError(
        response.status === 403
          ? "forbidden"
          : response.status === 404
            ? "not-found"
            : "unavailable",
      );
    const filename = `mock-invoice-${id}.txt`;
    if (
      !/^text\/plain;\s*charset=utf-8$/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      response.headers.get("content-disposition") !==
        `attachment; filename="${filename}"` ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new RemoteError("unavailable");
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "",
      size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) throw new RemoteError("unavailable");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      if (
        !text.startsWith(
          "SYNTHETIC DEMO INVOICE REFERENCE\nNOT A TAX INVOICE - NO FINANCIAL AUTHORITY\n\n",
        ) ||
        response.headers.get("content-length") !== String(size) ||
        signal.aborted
      )
        throw new RemoteError("unavailable");
      return { text, filename };
    } catch {
      throw new RemoteError("unavailable");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
