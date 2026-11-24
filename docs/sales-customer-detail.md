# Sales customer detail API (#69)

Normal, active Sales Staff can read details only for a currently active company where they hold the current active primary assignment. Each read reuses the existing profile provider to revalidate the live account, credential-bound session, access expiry, company and assignment before and after the company-scoped data read. Other roles are denied. The generic customer/tenant routes and their Sales restrictions are unchanged.

- `GET /api/v1/sales/companies/:companyId` returns `{company}` with ID, legal and trade names, status and ERP customer reference.
- `GET /api/v1/sales/companies/:companyId/users` returns customer-user IDs, company IDs, display names, roles and statuses.
- `GET /api/v1/sales/companies/:companyId/catalog` returns eligible active products with selling unit, MOQ and the resolved company/default browsing price or null.
- `GET /api/v1/sales/companies/:companyId/orders` returns non-draft order summaries. Drafts, historical snapshots, private notes and ERP errors are excluded.

List routes accept `offset` and `limit` only, default to 0 and 20, and return `{items,total,offset,limit}`. Limit is 1–100, offset at most 100000. Unknown, repeated, malformed or noncanonical selectors return 400. Counts and pages are scoped before serialization. Responses use existing no-store envelopes. Unassigned or suspended Sales authority returns 403 or a session failure; unavailable dependencies return 503 without a partial result.

The authorization checks bracket each repository read; these are not one shared database transaction or a cross-endpoint snapshot. A revoked assignment or session detected at the final check suppresses the result. Catalog prices are the existing scoped browsing projection, not a submission quote or stock reservation. Customer details, writes, invoices, order details and any Sales assignment management are not added by these endpoints.
