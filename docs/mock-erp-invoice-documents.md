# Mock synthetic invoice document source

Child #135 resolves the opaque reference introduced by #79. It supplies a trusted
Mock backend source only. Parent #81 still owns authenticated portal delivery/UI
and integrated acceptance; this child does not close #81.

After creating an issued invoice with the explicit completed order scenario, read
its existing metadata at `/mock-erp/v1/orders/:erpOrderId/invoice`. URL-encode the
exact `documentReference` value into:

```text
GET /mock-erp/v1/invoice-documents/:documentReference
```

For example, `mock-invoice:12345678-1234-4234-8234-123456789abc` resolves only the
invoice retained for that exact canonical lowercase ERP order ID. Metadata shape
and reference are unchanged. No arbitrary URL/path lookup, filesystem access,
redirect, upstream fetch or external renderer is used.

Successful GET returns a deterministic UTF-8 plain-text attachment, at most 4096
bytes, with the visibly synthetic heading:

```text
SYNTHETIC DEMO INVOICE REFERENCE
NOT A TAX INVOICE - NO FINANCIAL AUTHORITY
```

An explicit JSON metadata block follows: erpInvoiceReference, erpOrderId,
portalOrderId, customerId, invoiceNumber, status, amount, currency, issuedAt and
documentReference, copied exactly from the existing issued invoice. No submitted
names/reasons, private fields, taxes, recalculation, payment or new commercial
rules. The existing fixed demo amount remains exactly as metadata supplied it.
This minimal .txt format meets mock document/reference delivery without claiming
a real financial invoice or introducing a PDF dependency.

Headers:

- Content-Type: text/plain; charset=utf-8
- Content-Disposition: attachment with fixed `mock-invoice-<ERP-order-UUID>.txt`
  filename, never a caller-supplied path/name
- Content-Length: exact UTF-8 byte length
- Cache-Control: no-store
- X-Content-Type-Options: nosniff

No ETag, redirect, CORS or session/cookie is added. HEAD returns the same metadata
headers without bytes. Repeated/concurrent retrieval yields the same bytes and
never regenerates order/invoice identity, advances fulfillment or changes a
cancellation decision. Returned buffers are newly allocated detached output;
no document is stored as an arbitrary local file.

Malformed references, including URL/path/traversal/control/invalid encoding forms,
return fixed 400 INVALID_DOCUMENT_REFERENCE. Unknown, ordinary/unissued or
restarted-away invoice references return 404 INVOICE_DOCUMENT_NOT_FOUND. If a
future document would exceed the hard byte bound, fail with 503
INVOICE_DOCUMENT_UNAVAILABLE rather than sending unbounded output. Existing safe
Mock JSON error envelopes/no-store apply; no reference or internal path/error is
reflected in a diagnostic.

Invoices share the existing bounded 1000-order process ledger and disappear on
restart; a document exists only while its issued metadata exists. No scheduler,
persistent document store, financial authority or distributed lifecycle is claimed.

The frontend must ultimately download from a tenant-authorized Portal API, never
call the Mock directly. API owners must validate authorized invoice/order/company
correlation before resolving this backend-only reference and stream only the
bounded expected type. This Mock is the existing trusted development/test service,
not an authorization mechanism or public portal download endpoint.

Development/review order: #133 cancellation is already merged; #134/PR #138 adds
the shared Mock fulfillment/router state. This document-source PR is explicitly
based on codex/134-mock-fulfillment, with only its own incremental changes. Review
and merge #138 before the #135 child; retarget/update the child to main after its
parent lands through the normal owner process. If parent source changes, reconcile
and rerun relevant checks. No automatic merge or parent #66/#81 completion.

Run the Mock suite and root npm run check. Tests cover exact bytes/headers and
metadata correlation, detached buffers, size refusal, repeated/concurrent GET and
HEAD, unknown/unissued/restarted references, malformed URI/path/URL inputs,
no redirects/files, stable replay and unchanged invoice/fulfillment/cancellation.
