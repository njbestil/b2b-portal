import type {
  InvoiceLink,
  InvoiceMetadata,
  InvoiceRecord,
  InvoiceRepository,
  InvoiceSource,
} from "../repositories/invoices.js";
import type { CompanyRepository } from "../repositories/companies.js";
import type { PageRequest } from "../repositories/common.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import { checkedPage } from "./query-input.js";
export class InvoiceError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "not_found" | "unavailable" = "unavailable",
  ) {
    super("Invoice operation could not be confirmed.");
    this.name = "InvoiceError";
  }
}
export function invoiceId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
  )
    throw new InvoiceError("invalid_input");
  return value.toLowerCase();
}
export function invoiceTime(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new InvoiceError();
  return value;
}
export function invoiceText(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new InvoiceError();
  return value;
}
export function checkedInvoiceMetadata(row: InvoiceMetadata): InvoiceMetadata {
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    typeof row.amount !== "string" ||
    row.amount.trim() !== row.amount ||
    !/^(?:0|[1-9]\d{0,23})(?:\.\d{1,18})?$/.test(row.amount) ||
    typeof row.currency !== "string" ||
    row.currency.length !== 3 ||
    !/^[A-Z]{3}$/.test(row.currency) ||
    row.status !== "available" ||
    typeof row.documentReference !== "string" ||
    row.documentReference.length !== 49 ||
    !/^mock-invoice:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(
      row.documentReference,
    )
  )
    throw new InvoiceError();
  return {
    erpInvoiceReference: invoiceText(row.erpInvoiceReference),
    invoiceNumber: invoiceText(row.invoiceNumber),
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    documentReference: row.documentReference,
    issuedAt: invoiceTime(row.issuedAt),
  };
}
export function checkedInvoice(row: InvoiceRecord): InvoiceRecord {
  return {
    ...checkedInvoiceMetadata(row),
    id: invoiceId(row.id),
    companyId: invoiceId(row.companyId),
    orderId: invoiceId(row.orderId),
    syncedAt: invoiceTime(row.syncedAt),
  };
}
export function checkedLink(row: InvoiceLink): InvoiceLink {
  return {
    orderId: invoiceId(row.orderId),
    companyId: invoiceId(row.companyId),
    erpOrderReference: invoiceId(row.erpOrderReference),
    customerReference: invoiceText(row.customerReference),
  };
}
export function sameInvoiceLink(
  a: InvoiceLink | null,
  b: InvoiceLink,
): boolean {
  return (
    a !== null &&
    JSON.stringify(checkedLink(a)) === JSON.stringify(checkedLink(b))
  );
}
/** Explicit trusted operator consumer; never infers a link or updates order state. */
export function createInvoiceSync(
  source: InvoiceSource,
  repository: InvoiceRepository,
  newId: () => string,
  now = () => new Date().toISOString(),
) {
  return {
    async synchronize(orderId: string, signal: AbortSignal) {
      try {
        if (signal.aborted) throw new InvoiceError();
        const link = await repository.link(invoiceId(orderId));
        if (!link) throw new InvoiceError("not_found");
        const invoice = await source.read(checkedLink(link), signal);
        if (signal.aborted) throw new InvoiceError();
        if (invoice === null) return { available: false };
        await repository.save(
          link,
          checkedInvoice({
            ...invoice,
            id: newId(),
            companyId: link.companyId,
            orderId: link.orderId,
            syncedAt: now(),
          }),
        );
        return { available: true };
      } catch (e) {
        if (e instanceof InvoiceError) throw e;
        throw new InvoiceError();
      }
    },
  };
}
export const invoiceView = (input: InvoiceRecord) => {
  const row = checkedInvoice(input);
  return {
    id: row.id,
    orderId: row.orderId,
    invoiceNumber: row.invoiceNumber,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    issuedAt: row.issuedAt,
    syncedAt: row.syncedAt,
    documentAvailable: !!row.documentReference,
  };
};
export function createInvoiceQueries(
  repository: InvoiceRepository,
  companies: CompanyRepository,
) {
  async function scope(actor: AuthorizedActor) {
    requirePermission(actor, "invoices.read");
    const companyId = invoiceId(actor.companyId);
    const company = await companies.findById({ companyId });
    if (!company || company.id !== companyId || company.status !== "ACTIVE")
      throw new InvoiceError();
    return companyId;
  }
  return {
    async list(actor: AuthorizedActor, input?: PageRequest) {
      const companyId = await scope(actor);
      let page: PageRequest;
      try {
        page = checkedPage(input);
      } catch {
        throw new InvoiceError("invalid_input");
      }
      const result = await repository.list(companyId, page);
      if (
        !Number.isSafeInteger(result.total) ||
        result.total < 0 ||
        result.items.length > page.limit ||
        result.total < result.items.length ||
        result.items.some((r) => r.companyId !== companyId)
      )
        throw new InvoiceError();
      return { ...result, items: result.items.map(invoiceView), ...page };
    },
    async find(actor: AuthorizedActor, id: unknown) {
      const companyId = await scope(actor),
        key = invoiceId(id),
        row = await repository.find(companyId, key);
      if (!row) throw new InvoiceError("not_found");
      if (row.companyId !== companyId || row.id !== key)
        throw new InvoiceError();
      return invoiceView(row);
    },
  };
}
export type InvoiceQueries = ReturnType<typeof createInvoiceQueries>;
