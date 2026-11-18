import type { Page, PageRequest } from "./common.js";
export interface InvoiceLink {
  readonly orderId: string;
  readonly companyId: string;
  readonly erpOrderReference: string;
  readonly customerReference: string;
}
export interface InvoiceMetadata {
  readonly erpInvoiceReference: string;
  readonly invoiceNumber: string;
  readonly status: "available";
  readonly amount: string;
  readonly currency: string;
  readonly documentReference: string;
  readonly issuedAt: string;
}
export interface InvoiceRecord extends InvoiceMetadata {
  readonly id: string;
  readonly orderId: string;
  readonly companyId: string;
  readonly syncedAt: string;
}
export interface InvoiceSource {
  read(link: InvoiceLink, signal: AbortSignal): Promise<InvoiceMetadata | null>;
}
export interface InvoiceRepository {
  link(orderId: string): Promise<InvoiceLink | null>;
  save(link: InvoiceLink, invoice: InvoiceRecord): Promise<void>;
  list(companyId: string, page: PageRequest): Promise<Page<InvoiceRecord>>;
  find(companyId: string, id: string): Promise<InvoiceRecord | null>;
}
