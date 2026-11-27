# Request customer confirmation (#72 / B2B-060)

Sales Staff GET or POST
`/api/v1/sales/companies/:companyId/orders/:orderId/confirmation`.
POST requires one `Idempotency-Key` (1–128 printable ASCII characters) and only
`{version,customerUserId}`. The current primary Sales assignee must own an
untouched DRAFT/NOT_SENT order with an active delivery address and at least one
line. The designated contact must be an active Customer User or Customer Admin
in the same active company. Authority and expiry are rechecked at persistence.

The 202 response and GET return `{confirmation}` with server ID, order/contact
IDs, PENDING and creation time. GET returns null for an unrequested own order.
No fingerprint, ERP details or private notes are exposed. Matching requests
replay one record; a changed key/version/contact conflicts. The requested order
becomes PENDING_CUSTOMER_CONFIRMATION and stops being editable. No customer
decision, approval, ERP send or notification promise is added; #73/#74/#92 own
those steps. Commercial data must still be revalidated before eventual submission.

SQL uses the existing order_confirmations table and one transaction with the
order transition. Explicit migration 0011 adds a bounded nullable request
fingerprint for replay; historical rows with unknown identities cannot replay.
Apply migrations only to an authorized target; startup never migrates implicitly.
JSON retains the same logical confirmation record inside its order, so a single
synced temporary-file rename publishes record and state together. It shares the
credential/assignment/order coordinator. Existing writers preserve the private
record, reject unknown nested data and never project it into customer history.
JSON remains one process with offline external writers. Future decision states
must extend the validated record before enabling their writers.

POST audits each successful request/replay with actor/order/request IDs and no
contact details or key. Audit failure after commit is unconfirmed, not rollback:
use GET to inspect and retain the same key/body if explicitly retrying. No automatic
write replay. Error responses are fixed, private and no-store; mutations are
bounded to 20 attempts/actor/minute and four concurrent operations.

`confirmation-requests.test.mjs` covers actual SQL/JSON/HTTP, race/replay,
publication rollback and uncertain commit, scoped contact/creator/assignment,
expiry and preservation of private data by existing writers.
