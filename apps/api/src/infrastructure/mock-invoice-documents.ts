import {
  parseErpEnvironment,
  type ErpEnvironment,
} from "@b2b-portal/config/server";
import type { InvoiceDocumentSource } from "../services/invoice-documents.js";
import { InvoiceError } from "../services/invoices.js";

/** Only the configured Mock ERP origin and a server-owned opaque reference. */
export function createMockInvoiceDocuments(
  config: ErpEnvironment,
): InvoiceDocumentSource {
  const validated = parseErpEnvironment({
    ERP_BASE_URL: config.baseUrl,
    ERP_TIMEOUT_MS: String(config.timeoutMs),
  });
  if (!validated) throw new InvoiceError();
  return {
    async read(invoice, link, signal) {
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, validated.timeoutMs);
      try {
        const response = await fetch(
          new URL(
            `invoice-documents/${encodeURIComponent(invoice.documentReference)}`,
            validated.baseUrl,
          ),
          {
            signal: controller.signal,
            redirect: "error",
            headers: { accept: "text/plain" },
          },
        );
        if (
          !response.ok ||
          !/^text\/plain;\s*charset=utf-8$/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          !response.body ||
          response.headers.get("content-disposition") !==
            `attachment; filename="mock-invoice-${link.erpOrderReference}.txt"`
        ) {
          await response.body?.cancel();
          throw new InvoiceError();
        }
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4096) throw new InvoiceError();
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const bytes = Buffer.concat(chunks),
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const expected =
          "SYNTHETIC DEMO INVOICE REFERENCE\nNOT A TAX INVOICE - NO FINANCIAL AUTHORITY\n\n" +
          JSON.stringify(
            {
              erpInvoiceReference: invoice.erpInvoiceReference,
              erpOrderId: link.erpOrderReference,
              portalOrderId: invoice.orderId,
              customerId: link.customerReference,
              invoiceNumber: invoice.invoiceNumber,
              status: invoice.status,
              amount: invoice.amount,
              currency: invoice.currency,
              issuedAt: invoice.issuedAt,
              documentReference: invoice.documentReference,
            },
            null,
            2,
          ) +
          "\n";
        if (
          text !== expected ||
          response.headers.get("content-length") !== String(bytes.length) ||
          signal.aborted
        )
          throw new InvoiceError();
        return bytes;
      } catch {
        throw new InvoiceError();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
