# Internal order notes (#71 / B2B-059)

GET or POST `/api/v1/companies/:companyId/orders/:orderId/internal-notes`.
POST accepts only `{note}`: trimmed, nonblank, at most 4000 Unicode characters,
without NUL. The server supplies UUID, author and UTC time. GET supports only
`offset` (0–100000) and `limit` (1–100, default 20), ordered by creation time/UUID.
Notes are plain text, append-only and separate from customer order projections.
Customers cannot call either operation. Sales must currently be assigned to the
active company; Internal Admin keeps the existing internal read/append capability.

The selected provider wraps the existing note adapter. PostgreSQL locks the
company, current credential/session and assignment through the existing note
statement and rechecks expiry before commit. JSON uses the shared coordinator
across credential/assignment/order/note operations and checks expiry immediately
before private-file publication. No new table, file format, dependency or
customer DTO is introduced. Unsupported/corrupt storage fails closed; no runtime
provider fallback. JSON remains one process with offline external writers.

Audit records contain actor/company/order/request IDs and outcome, never note
text. Like existing draft writes, a failed post-commit audit is unconfirmed:
the API returns unavailable and callers must reread before another append.
There is no automatic retry or exactly-once promise. Mutation access is bounded
to 30 attempts per actor/minute; at most four operations run concurrently.
The Sales UI remains #75 and should render note text as text, never HTML.

`order-notes-workflow.test.mjs` verifies actual JSON/SQL append/list, concurrent
notes, detached paging, current authority, customer/tenant privacy, generic
errors and no-store behavior. Existing `internal-notes.test.mjs` retains storage,
publication and migration coverage.
