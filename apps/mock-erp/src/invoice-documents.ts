import type { ErrorRequestHandler } from "express";
import { OrderError, type MockErpInvoice } from "./orders.js";

export const maximumInvoiceDocumentBytes = 4096;
function missing(): never {
  throw new OrderError(
    404,
    "INVOICE_DOCUMENT_NOT_FOUND",
    "Mock invoice document not found.",
  );
}
/** Resolve only the exact issued opaque reference; no filesystem or network I/O. */
export function resolveInvoiceDocument(
  reference: unknown,
  findInvoice: (erpOrderId: string) => MockErpInvoice | null,
): { bytes: Buffer; filename: string } {
  if (
    typeof reference !== "string" ||
    !/^mock-invoice:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(
      reference,
    )
  )
    throw new OrderError(
      400,
      "INVALID_DOCUMENT_REFERENCE",
      "Invalid mock invoice document reference.",
    );
  const erpOrderId = reference.slice("mock-invoice:".length);
  let invoice: MockErpInvoice | null;
  try {
    invoice = findInvoice(erpOrderId);
  } catch (error) {
    if (error instanceof OrderError && error.code === "ORDER_NOT_FOUND")
      return missing();
    throw error;
  }
  if (
    !invoice ||
    invoice.erpOrderId !== erpOrderId ||
    invoice.documentReference !== reference
  )
    return missing();
  // Explicit projection prevents future private fields from entering the file.
  const metadata = {
    erpInvoiceReference: invoice.erpInvoiceReference,
    erpOrderId: invoice.erpOrderId,
    portalOrderId: invoice.portalOrderId,
    customerId: invoice.customerId,
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    amount: invoice.amount,
    currency: invoice.currency,
    issuedAt: invoice.issuedAt,
    documentReference: invoice.documentReference,
  };
  const bytes = Buffer.from(
    "SYNTHETIC DEMO INVOICE REFERENCE\nNOT A TAX INVOICE - NO FINANCIAL AUTHORITY\n\n" +
      JSON.stringify(metadata, null, 2) +
      "\n",
    "utf8",
  );
  if (bytes.byteLength > maximumInvoiceDocumentBytes)
    throw new OrderError(
      503,
      "INVOICE_DOCUMENT_UNAVAILABLE",
      "Mock invoice document unavailable.",
    );
  return { bytes, filename: `mock-invoice-${erpOrderId}.txt` };
}

/** Express can reject malformed URI encoding before the document handler runs. */
export const documentReferenceErrorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  _response,
  next,
) => {
  next(
    error instanceof URIError
      ? new OrderError(
          400,
          "INVALID_DOCUMENT_REFERENCE",
          "Invalid mock invoice document reference.",
        )
      : error,
  );
};
