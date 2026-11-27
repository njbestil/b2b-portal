# Invoice UI and mock document (#81 / B2B-069)

The customer Invoices workspace uses the existing company-scoped list/detail API.
It shows exact amount strings, currency, issue/update dates and only the available
status returned by the source. There is no inferred Paid/Due, VAT, payment ledger
or automatic synchronization. Preview/internal/restricted accounts cannot load data.

GET `/api/v1/invoices/:id/document` requires normal `invoices.read` access. It
resolves the authorized company invoice and existing order/customer link, then
retrieves only its opaque reference from the configured Mock ERP origin. It uses
no redirects, a timeout, a 4 KiB stream limit and strict UTF-8/type/filename/length
and exact metadata checks. The live account, company, session and access expiry,
plus the invoice and order link, are rechecked after remote I/O. Foreign/missing
invoices share 404; corrupt/unavailable sources are generic 503. No writes occur.

The response is a no-store, nosniff text attachment named using the Portal invoice
ID. The browser downloads it through SessionClient, never a Mock URL or token in
a link. The document contains its own correlated Mock ERP references, is visibly
synthetic and has no financial authority. This source is composed only outside
production with explicit Mock configuration; otherwise download is unavailable.
There is no filesystem document lookup, provider URL supplied by a customer,
production adapter, PDF rendering, invoice sync or financial mutation in this issue.

Verification: actual HTTP/JSON/PostgreSQL/Mock tests cover authorized retrieval,
tenant/role restrictions, live revocation, changed links and no metadata mutation.
Adapter/client tests cover redirects, bounds, bad UTF-8, mismatches, timeout,
malformed payloads and exact decimal display. Browser and combined-suite evidence
is recorded in the review PR.
