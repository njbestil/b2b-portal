# Invoice synchronization and customer reads (#80)

ERP owns invoice number, status, amount, currency, issue time and document
reference. The portal caches exact metadata; it does not calculate totals or
change order business/integration state. The only implemented invoice source is
the explicit development/test [Mock completed fixture](mock-erp-invoices.md).
It is not a production financial integration or fulfillment engine.

## Customer API

Authenticated, normal-access Customer Admin and Customer User can call:

- `GET /api/v1/invoices?offset=0&limit=20`
- `GET /api/v1/invoices/:id`

Both use the standard success/error envelope and `Cache-Control: no-store`.
Company scope comes only from the validated current principal. Company overrides,
unknown/repeated query parameters, negative offsets and limits outside 1–100
return 400. Lists return `{items,total,offset,limit}`, filtered by company before
counting/paging, ordered by issuedAt descending then local ID ascending. Missing
and foreign detail IDs return the same 404 `INVOICE_NOT_FOUND`. Internal Admin
and Sales are denied by this customer-only contract. Restricted first-login,
expired/revoked/inactive principals use existing authentication denial behavior.

Public invoice fields: `id`, `orderId`, `invoiceNumber`, `status`, `amount`
(exact decimal string), `currency`, `issuedAt`, `syncedAt`, `documentAvailable`.
ERP customer/order/invoice references and opaque document references are private.
Document availability is metadata only; #81 owns document delivery and UI.
Storage/source details never appear in customer errors. Unconfigured storage or
corrupt cache returns 503 `INVOICES_UNAVAILABLE`, not an empty success fallback.

Reads use the cache and do not contact ERP. An empty cache returns an empty page.
They neither trigger synchronization nor infer invoice data from order totals.

## Explicit local operator synchronization

Build first. Set `NODE_ENV=development` (or `test`) and backend-only
`ERP_BASE_URL`/`ERP_TIMEOUT_MS`. Stop API/all JSON writers. The order must already
have an ERP link: SQL `orders.erp_order_reference`, JSON `erpOrderReference`.
Its company must have `erpCustomerReference`, and its status must not be a draft
or pending customer confirmation. No link is inferred from an order number or
status, and no endpoint in this issue creates that link. #62 owns the eventual
portal submission/link producer. Existing unlinked demo orders refuse sync.

For an already seeded, marked dedicated JSON store, leave `DATABASE_URL` unset:

```powershell
npm run sync:invoice --workspace=@b2b-portal/api -- --provider json --directory D:/private/b2b_demo_local --confirm-target b2b_demo_local --offline --order YOUR_LINKED_PORTAL_ORDER_UUID
```

For an already migrated/marked disposable native loopback PostgreSQL database,
privately set `DATABASE_URL` to that exact confirmed `b2b_demo_*` target:

```powershell
npm run sync:invoice --workspace=@b2b-portal/api -- --provider postgresql --confirm-target b2b_demo_local --offline --order YOUR_LINKED_PORTAL_ORDER_UUID
```

Neither command migrates, seeds, resets, provisions accounts, accepts passwords
in arguments, or switches providers. Production/remote/unmarked targets refuse.
The JSON operator shares the seed/catalog/account sibling lock and rejects linked
directory ancestry. The SQL operator verifies server loopback and the public
schema demo marker. Stop writers as declared by `--offline`; the flag is an
operator assertion, not an external process detector.

The source fetch uses server-derived ERP order/customer links, bounded timeout,
16 KiB response, strict JSON/UTF-8 and no redirects. Invoice/customer/order
correlation and opaque document scheme are checked before writing. A known
`invoice:null` returns `invoice.synced` with `available:false` without deleting
previous cache data. Source errors/404/timeouts, malformed/cross-linked data or
changed local links fail safely and preserve existing invoices. There is no
automatic retry, expiry, background sync or tombstone policy in this issue.

Upsert uses the stable ERP invoice reference while retaining the portal UUID;
existing ownership cannot be reassigned. SQL rechecks/locks the order/company
link and publishes transactionally; JSON rechecks under the shared coordinator
and atomically publishes a bounded `invoices.json` (10 MiB / 10000 records).
Offline catalog/account swaps preserve this file. Explicit confirmed demo reset
clears it; unknown files and unsafe reset targets remain refused. Order rows,
snapshots, lines and business/integration statuses are never written by sync.

Completion logs contain only `invoice.synced` and an availability boolean;
failure logs contain only `invoice.sync_failed`, with nonzero exit. Restart the
API with the same selected store to expose newly cached invoices.

Run `node --test --test-concurrency=1 apps/api/test/invoices.test.mjs` after
building API and Mock ERP, then `npm run check`. Real SQL cases opt in via
`B2B_TEST_MIGRATIONS_DATABASE_URL` pointed only at a disposable local cluster.
