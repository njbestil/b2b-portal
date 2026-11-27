# Sales-assisted drafts (#70 / B2B-058)

Sales Staff may POST `/api/v1/sales/companies/:companyId/order-drafts`, GET or
PATCH `/:id`, GET or POST `/:id/items`, and PATCH or DELETE `/:id/items/:itemId`.
Bodies match the existing draft/address/item contracts, including the canonical
draft version for changes. There is no delete-order, confirmation or submit route
in this workflow. #72–#74 own confirmation and later submission; #75 owns the UI.

The server binds creator and company, and reuses the existing draft service,
version hashing, eligible-product/MOQ/quantity rules and address checks. Both
providers recheck current Sales credentials, normal session, active company and
the current primary assignment inside the same transaction/coordinator operation
as the read or write. SQL holds company/user/session/assignment locks through the
draft operation; JSON serializes with all supported credential/assignment/order
writers. Other creators' drafts and non-DRAFT or already-sent orders cannot be
edited. Customer draft/submission permissions and commercial authority are unchanged.

No schema, dependency or JSON file-format change. Private fields and existing
history are retained by the existing writers. Required audit follows the existing
draft service: a failed post-commit audit returns unconfirmed/unavailable, and the
caller must reread before another action. Do not automatically repeat creation or
editing after an uncertain response. Hosted JSON remains disposable and requires
one process/coordinator and offline external writers.

Test `sales-drafts.test.mjs` with `B2B_TEST_MIGRATIONS_DATABASE_URL` for real
SQL/JSON parity, API authorization, creator/tenant/assignment checks, stale
versions, concurrent edits, canonical state and item/address validation.
