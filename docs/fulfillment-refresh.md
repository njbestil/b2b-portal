# ERP fulfillment business-status refresh (#66)

A normal authenticated Internal Admin can explicitly request:

`POST /api/v1/admin/companies/:companyId/orders/:orderId/fulfillment/refresh`

The permission is `orders.fulfillment.refresh`; Sales Staff and both customer
roles cannot trigger writes. Accept exactly an empty JSON object `{}` and no
query selectors. Company/order IDs are UUIDs; the server obtains ERP identity
from current storage. Caller status, provider headers, reference overrides and
Mock scenario controls are never forwarded. This is an explicit bounded refresh,
not a background poller or new frontend workflow.

HTTP 200 returns the standard no-store envelope containing only
`data: {orderId, companyId, status, changed}`. Status is CONFIRMED, FULFILLING or
DELIVERED; changed=false denotes an equal verified observation with no mutation
or duplicate transition audit.

## Mapping and ownership

The new ERP-neutral source translates only #134's settled Mock contract:
GET orders/:erpOrderId/fulfillment, exact fields erpOrderId, portalOrderId,
customerId, fulfillmentStatus and updatedAt. Exact lowercase confirmed,
fulfilling and delivered map to CONFIRMED, FULFILLING and DELIVERED.
The adapter validates exact keys, correlation, UUIDs, bounded customer reference
and a finite canonical ISO timestamp no later than the current time. Unknown
states, aliases, order.created and invoice availability never infer fulfillment.
Timestamp validity is rechecked at the service/provider publication boundary.

Allowed business ranks are SUBMITTED → CONFIRMED → FULFILLING → DELIVERED.
Forward skips are allowed for missed observations; equal state is a verified
no-op. Regressions refuse. DRAFT, PENDING_CUSTOMER_CONFIRMATION, CANCELLED and
REJECTED cannot change through this capability; DELIVERED permits only an equal
DELIVERED no-op. The retained business rank guards delayed/out-of-order responses;
no new provider timestamp checkpoint or migration is introduced.

Only orders.order_status (JSON status) changes. Technical integration status,
transaction/attempt records, retry counters/classification/scheduling, ERP links,
updatedAt, submitted snapshots, items and every other existing order field remain
unchanged. There is deliberately no technical SUCCESS prerequisite: verified
business fulfillment may advance while technical status is SUCCESS, FAILED,
RETRYING, PROCESSING or another existing value. No integration-table access or
locks are required. Submission/technical dispatch remains #62/#63 and retry work
remains #64; this feature neither dispatches nor retries requests.

An existing linked company may have any lifecycle state: Internal Admin records
ERP historical truth while suspended/customer accounts still cannot gain access
or place orders. This grants no customer/Sales read or mutation authority.

## Current authority, correlation and publication

The service requires the existing opaque actor capability. Before ERP I/O and
again after awaiting it, providers recheck current normal Internal Admin role,
null company, active account, first-login flag, credential-bound unrevoked
session, hard expiry and admitted access expiry. Capture stores the current
company/order/ERP-order/customer-reference linkage; publication rechecks that
exact linkage against both current storage and the observation. An ERP customer
or order reassignment during the network wait cannot apply a stale response.
No database/coordinator ownership is held across ERP network I/O.

SQL uses short capture/apply transactions, locking company → actor user → actor
session → in-company order. It checks expiry/cancellation again after statement
waits and before COMMIT; update failures roll back. It modifies only the business
status column and never locks integration records. Concurrent observations
serialize at the current business-state check, so a lower observation cannot
regress a committed higher rank.

JSON shares the existing security coordinator and orders.json file. It compares
raw data to the validated collection using semantic deep equality, independent
of object-key order. Unsupported top-level or nested private fields refuse
before publication rather than being canonicalized away. Known fields and
snapshots are retained. One complete private staged/synced atomic replacement
changes status only, with authority, expiry, observation-time and cancellation
checks immediately before rename. A known completed rename returns committed
state so required audit is attempted even if expiry/cancellation arrives just
afterward. A no-op retains its final check. An error with unknown after-effect
may return an unconfirmed 503; no prior state is restored. Existing one-writer
process/directory and offline-writer-stop constraints remain. Files are bounded
to 10 MiB and existing collection limits; unresolved application intents refuse.

## Failures and bounds

Required audit action order.fulfillment_updated records actor, company/order,
request ID, success and changed-field name only, after a real state change.
There are no raw ERP payloads, URLs, errors, credentials or snapshot contents in
responses/logs/audit metadata. Required audit failure returns 503 without undoing
a committed status; a verified repeat can confirm it as an equal no-op. This is
not an atomic audit repair guarantee.

Invalid body/path/query: 400 INVALID_FULFILLMENT_REQUEST. Missing in-company
target: 404 FULFILLMENT_NOT_FOUND. Unlinked/ineligible business state, regression
or changed current correlation: 409 FULFILLMENT_CONFLICT. Source/storage/audit or
unconfirmed result: 503 FULFILLMENT_UNAVAILABLE. Existing session/role errors keep
their 401/403/503 envelopes.

Require uncompressed application/json bounded to 1 KiB (415/413 for media/size).
Each administrator gets ten attempts per minute in a bounded 1000-entry map
(429 with Retry-After). Four actual async refresh operations may run at once
(503 on overload); disconnect does not release a slot until its operation
settles. Capacity is acquired after body parsing, so parser errors cannot leak a
slot. Disconnect cancels eligible work, but already committed work is audited.
The Mock adapter enforces configured timeout/cancellation, refuses redirects,
non-JSON, invalid UTF-8 and responses above 4 KiB, with fixed unavailable errors.
Mock down/timeout/malformed/unknown-after-restart responses never publish status.
Runtime composes this Mock source only with explicit ERP configuration outside
production; missing configuration/production have no fallback and return 503.

## Verification

`apps/api/test/fulfillment.test.mjs` covers SQL/JSON and actual Mock/HTTP/session
flows: all three fixtures across independent technical states; complete stored
field/snapshot/transaction preservation; monotonic skips/equality/terminal and
concurrent races; current actor/correlation/expiry after network/SQL waits;
rollback; no integration-record locking; JSON unknown private fields, semantic
key order, staged-before/after-effect failures and expiry/abort boundaries;
adapter malformed/down/stall/redirect/restart; HTTP role/body/rate/capacity and
disconnect safety. Both review-discovered disconnect-capacity and known-commit
reporting defects have observed failing-before/passing-after regressions.
A real #62 SQL submission receipt is refreshed from the retained Mock record
without altering its dispatch evidence. Actual API process tests verify enabled
nonproduction and fail-closed production/absent-source composition.
