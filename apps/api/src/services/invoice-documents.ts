import type {
  InvoiceLink,
  InvoiceRecord,
  InvoiceRepository,
} from "../repositories/invoices.js";
import type { CompanyProfileRepository } from "../repositories/company-profiles.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import {
  checkedInvoice,
  checkedLink,
  invoiceId,
  InvoiceError,
  sameInvoiceLink,
} from "./invoices.js";

export interface InvoiceDocumentSource {
  read(
    invoice: InvoiceRecord,
    link: InvoiceLink,
    signal: AbortSignal,
  ): Promise<Buffer>;
}
/** Read-only retrieval. Recheck live authority and the exact link after remote I/O. */
export function createInvoiceDocuments(
  repository: InvoiceRepository,
  profiles: CompanyProfileRepository,
  source: InvoiceDocumentSource,
) {
  return {
    async read(actor: AuthorizedActor, input: unknown, signal: AbortSignal) {
      requirePermission(actor, "invoices.read");
      const companyId = invoiceId(actor.companyId),
        id = invoiceId(input);
      const current = async () => {
        const profile = await profiles.read(actor, companyId);
        if (
          profile.id !== companyId ||
          profile.status !== "ACTIVE" ||
          signal.aborted
        )
          throw new InvoiceError();
      };
      await current();
      const row = await repository.find(companyId, id);
      if (!row) throw new InvoiceError("not_found");
      const invoice = checkedInvoice(row),
        rawLink = await repository.link(invoice.orderId);
      if (invoice.companyId !== companyId || invoice.id !== id || !rawLink)
        throw new InvoiceError();
      const link = checkedLink(rawLink);
      if (
        link.companyId !== companyId ||
        link.orderId !== invoice.orderId ||
        invoice.documentReference !== `mock-invoice:${link.erpOrderReference}`
      )
        throw new InvoiceError();
      const bytes = await source.read(invoice, link, signal);
      await current();
      const latest = await repository.find(companyId, id);
      if (
        !latest ||
        JSON.stringify(checkedInvoice(latest)) !== JSON.stringify(invoice) ||
        !sameInvoiceLink(await repository.link(invoice.orderId), link) ||
        !Buffer.isBuffer(bytes) ||
        !bytes.length ||
        bytes.length > 4096 ||
        signal.aborted
      )
        throw new InvoiceError();
      await current();
      return { bytes, filename: `mock-invoice-${id}.txt` };
    },
  };
}
export type InvoiceDocuments = ReturnType<typeof createInvoiceDocuments>;
