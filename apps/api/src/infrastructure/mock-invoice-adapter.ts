import {
  parseErpEnvironment,
  type ErpEnvironment,
} from "@b2b-portal/config/server";
import type {
  InvoiceSource,
  InvoiceMetadata,
} from "../repositories/invoices.js";
import {
  InvoiceError,
  checkedInvoiceMetadata,
  checkedLink,
} from "../services/invoices.js";
export function createMockInvoiceSource(config: ErpEnvironment): InvoiceSource {
  const validated = parseErpEnvironment({
    ERP_BASE_URL: config.baseUrl,
    ERP_TIMEOUT_MS: String(config.timeoutMs),
  });
  if (!validated) throw new InvoiceError();
  return {
    async read(input, signal) {
      const link = checkedLink(input),
        controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, validated.timeoutMs);
      try {
        const response = await fetch(
          new URL(
            `orders/${link.erpOrderReference}/invoice`,
            validated.baseUrl,
          ),
          {
            signal: controller.signal,
            redirect: "error",
            headers: { accept: "application/json" },
          },
        );
        if (
          !response.ok ||
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          !response.body
        ) {
          await response.body?.cancel();
          throw new InvoiceError();
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
            if (size > 16384) throw new InvoiceError();
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const body = JSON.parse(text);
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).join(",") !== "invoice"
        )
          throw new InvoiceError();
        if (body.invoice === null) return null;
        const row = body.invoice;
        if (
          !row ||
          row.portalOrderId !== link.orderId ||
          row.erpOrderId !== link.erpOrderReference ||
          row.customerId !== link.customerReference ||
          row.documentReference !== `mock-invoice:${link.erpOrderReference}`
        )
          throw new InvoiceError();
        if (
          Object.keys(row).sort().join(",") !==
          "amount,currency,customerId,documentReference,erpInvoiceReference,erpOrderId,invoiceNumber,issuedAt,portalOrderId,status"
        )
          throw new InvoiceError();
        return checkedInvoiceMetadata(row as InvoiceMetadata);
      } catch {
        throw new InvoiceError();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
