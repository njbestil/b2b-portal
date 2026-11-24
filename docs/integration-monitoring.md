# ERP integration transaction monitoring (#85)

Normal authenticated Internal Admin can search and inspect retained technical
integration transactions with `integration-transactions.read`:

- `GET /api/v1/admin/integration-transactions`
- `GET /api/v1/admin/integration-transactions/:id`

Sales Staff and customer roles cannot use either endpoint. This is API-only
monitoring; #88 owns composed administration UI. It adds no dispatch, retry,
cancellation, reconciliation or other write operation, and does not infer order
business status from technical state.

## Safe summaries and detail

List returns the standard no-store envelope with
`data: {items, total, offset, limit}`. Detail returns `data: {transaction}`.
Each transaction has exactly:

id, companyId, orderId, operation, status, retryable, retryCount, nextRetryAt,
errorCode, createdAt and updatedAt.

The six exact technical statuses are NOT_SENT, PENDING, PROCESSING, SUCCESS,
FAILED and RETRYING. `retryCount` and scheduling fields show the producer's
retained current values; they are not a complete attempt log or a promise that
an interrupted operation will be retried. No business status mutation is made.

Only the current known operation ORDER_SUBMISSION is exposed by name. Every
other raw operation is projected as OTHER, including future operations until
an explicit reviewed allowlist update. Null error code remains null; the fixed
known codes OUTCOME_UNKNOWN, ERP_TEMPORARY_FAILURE, ERP_UNAVAILABLE, ERP_TIMEOUT,
ERP_VALIDATION_FAILED, CREDIT_HOLD, INSUFFICIENT_STOCK and INVALID_ITEM are exposed
by name. Any other raw code becomes UNRECOGNIZED.

No request/response payloads, error_message, idempotency keys, credentials,
provider errors/text, ERP references, customer/user names or arbitrary columns
are fetched into the transaction DTO. Detail deliberately uses the same safe
projection as list. Service output also applies a fixed field whitelist.
Search/query values and transaction payloads are absent from request logs.

## Search and pagination

List accepts only these single-value query keys:

- offset: canonical nonnegative integer, default 0, maximum 100000.
- limit: canonical integer from 1 to 100, default 20.
- status: one exact technical status above.
- companyId and orderId: optional UUID equality filters.
- q: optional nonblank text, at most 128 characters before trimming, containing
  ASCII letters, digits, underscores, hyphens and spaces only.

Repeated values, arrays/objects, unknown selectors, malformed UUIDs, fractional,
negative, leading-zero or excessive page values refuse with 400. Detail accepts
one UUID path and no query selectors.

q is a case-insensitive literal substring of the projected transaction UUID,
company UUID, order UUID, operation label, technical status or safe error-code
label. It does not search raw operation/error text, payloads, keys or provider
references, including through count or paging side channels. There are no LIKE
wildcards or query-language operators. Searching OTHER or UNRECOGNIZED can find
those safe categories; searching an unknown raw value cannot reveal it.

Filtering occurs before totals and pagination. A single data statement/snapshot
returns the exact matching total and page, including a correct total when offset
is beyond the final row. Ordering is native PostgreSQL created_at descending,
then UUID ascending for a true timestamp tie. API timestamps are canonical ISO
milliseconds; native sub-millisecond ordering is preserved even when two DTO
timestamps appear equal. No timestamp truncation is applied to SQL ordering.

## Selected storage and current access

PostgreSQL reads the existing integration_transactions producer directly. Every
operation uses READ COMMITTED READ ONLY, a local 2-second statement timeout and
1-second lock timeout. No writer locks or data/schema changes are introduced.
List's total/page share one data snapshot; producers may progress between reads.
Detail is likewise a current retained summary, not a historical audit feed.

Current active/null-company Internal Admin, first-login flag, credential-bound
unrevoked session, hard expiry and strict admitted access expiry are checked
before data SQL and again from a fresh authority statement after data SQL. The
service also checks strict expiry/cancellation before awaiting the repository
and before disclosure. Monitoring does not borrow the existing JWT validation
clock tolerance. Expiry after pool checkout or during a query, credential/role/
account changes or revocation before the final authority check deny disclosure.
No arbitrary raw data is returned in an error. Already-completed admission keeps
its normal immediate return boundary; reads do not lock out account writers.

Deadline/cancellation/storage failures roll back the read-only transaction and
release the connection. Local timeouts do not persist on a reused connection.
Runtime monitoring does not require ERP configuration and works in production
against its selected PostgreSQL storage; it performs no upstream request.

JSON has no durable integration-transaction producer or existing transaction
collection. Its selected capability deliberately returns 503 for list and detail.
It does not invent a healthy empty dashboard, read a manually placed transaction
file, add a new JSON store or fall back to another provider. This is the honest
capability boundary shared with SQL-only submission/retry producers.

## HTTP limits and errors

All responses are no-store. Invalid query/path is
400 INVALID_INTEGRATION_MONITOR_REQUEST; missing transaction is
404 INTEGRATION_TRANSACTION_NOT_FOUND; unavailable JSON/database/cancelled or
unconfirmed read is 503 INTEGRATION_MONITOR_UNAVAILABLE. Existing session and
role admission retain their 401/403/503 envelopes.

Thirty requests per minute per administrator use a bounded 1000-entry map;
excess requests return 429 INTEGRATION_MONITOR_RATE_LIMITED with Retry-After.
At most four actual async monitoring reads run together. Slots are held until
the handler finally settles, including after a disconnect, so disconnected
pending SQL cannot admit an unbounded backlog. Disconnect cancels disclosure;
server-side SQL deadlines bound work that cannot immediately be cancelled.
There is no monitoring write/audit/attempt record created by inspection.

## Verification

`apps/api/test/integration-monitor.test.mjs` exercises real SQL/JSON/session/HTTP:
all statuses and known/unknown safe labels, hidden-field search/count privacy,
true timestamp ties and native microsecond precision, stable pages/totals/detail,
read-only state preservation, writer concurrency, actual row/DDL/query/pool waits,
server deadlines and connection reuse, current role/credential/revocation/expiry
before and after queries, JWT clock-tolerance rejection, disclosure cancellation,
actual-operation capacity through disconnect, rate/errors/log privacy and honest
JSON unavailability. A real merged submission/retry pipeline is inspected during
processing/backoff and after success without changing retained evidence. Actual
API processes verify production PostgreSQL without ERP configuration and JSON503.
The microsecond ordering regression was observed failing before its minimal fix
and passing afterward. Independent acceptance/owner review remains separate from
implementer verification.
