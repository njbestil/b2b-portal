# Sales assignment management (#84)

Only normal authenticated Internal Admin can use `sales-assignments.manage`.
This administration capability is separate from #34's unchanged Sales read/policy
port. #88 owns composed administration UI.

## Read and assign

`GET /api/v1/admin/companies/:companyId/sales-assignment` returns the current
active primary assignment, or null if none exists. It permits an existing
company in any lifecycle state for administrative inspection.

`PUT /api/v1/admin/companies/:companyId/sales-assignment` accepts exactly:

```json
{
  "salesStaffUserId": "00000000-0000-4000-8000-000000000001",
  "expectedAssignmentId": null
}
```

Use null only when GET reports no current primary. For reassignment, pass the
current assignment's UUID as expectedAssignmentId. A stale token or same-owner
replacement returns 409 without changing history. IDs are UUIDs; no query
selectors or caller-supplied role, company, creator, timestamps, active or
primary flags are accepted. There is no delete/unassign operation.

Both endpoints return HTTP 200 with the standard envelope containing
`data.assignment`: null for an unassigned company read, otherwise exactly id,
companyId, salesStaffUserId, assignedByUserId, isPrimary, active, createdAt and
endedAt. A published assignment has server-generated id, authenticated creator,
isPrimary=true, active=true, current timestamp and endedAt=null. No credentials,
user names, emails, session data or arbitrary underlying fields are projected.

A successful write ends every prior active assignment for this company with the
same timestamp and appends one new active primary. Historical rows are retained
with original owner/creator/start time and primary flag. Rows for other
companies remain unchanged. Exactly one active primary exists for the resulting
assigned company. Existing unassigned companies are not automatically populated.

## Eligibility and access

The company must currently be ACTIVE or SUSPENDED. Assignment during suspension
allows administrative owner correction; it grants no Sales access while the
company remains suspended. PENDING, REJECTED and DEACTIVATED companies cannot be
assigned. Missing company/target and ineligible-role/company-bound recipient
share a 404; an inactive Sales recipient conflicts.

The recipient must currently be ACTIVE, SALES_STAFF and companyId=null.
The recipient may still have mustChangePassword=true, preserving #83's
create→assign onboarding. Existing #34 policy continues to deny all assignment
use until the mandatory first-login password change and fresh login complete.
No password, first-login flag or session is changed by assignment management.

Old/new owners use current policy on each operation. After committed
reassignment the next request denies the old owner and permits the eligible new
owner; existing login proofs do not cache ownership. Already-admitted work may
finish. Inactive staff and suspended companies remain denied even when their
historical/current assignment rows are retained. Existing Internal Admin
historical visibility is unchanged.

## Consistency, bounds and failures

The service requires the existing opaque actor capability. Providers recheck
current Internal Admin role, null company, active account, first-login flag,
credential-bound unrevoked session, hard expiry and admitted access expiry under
write ownership. They also recheck company/recipient state and expected owner.

PostgreSQL locks company, sorted actor/recipient user rows, actor session and
company assignment rows, in that order. The company lock serializes even first
assignments with no existing row. Ending old records and inserting the new row
share one transaction and the existing partial unique indexes. Authority/expiry
is checked again after statement waits before commit. Failed inserts roll back
ended history. No migration is added.

JSON uses the existing shared security coordinator and the same private
customer_sales_assignments.json file/model as policy readers. The shared reader
retains shape, UTF-8, UUID, reference, time and uniqueness checks. One complete
file replacement publishes ended history plus new ownership atomically. The
writer checks expiry again after staging/sync immediately before rename. A
failure before replacement leaves old ownership; a failure after replacement may
leave complete new ownership. No intermediate empty or double-primary state is
published. One trusted writer process per directory remains required; offline
changes require all writers stopped. Temporary files use exclusive creation,
private mode and cleanup. Existing JSON limits are 2 MiB/10000 total retained
assignment rows; PostgreSQL administration bounds each company history read to 10000. At that SQL limit, a write is refused before any old row is ended or a
new row is inserted, retaining a readable current owner. History is never
silently truncated to make space. Malformed/orphaned,
duplicate or future-active evidence refuses with 503 rather than choosing an
owner. There is no provider fallback.

Required audit events sales_assignment.assigned/reassigned run after publication
with actor, company, assignment ID, request ID, outcome and changed-field names.
They contain no account payloads or credentials. Required audit failure returns
503 without undoing committed ownership; GET the same endpoint before retrying.
This follows existing committed-but-unconfirmed mutation semantics. An old
expected token then conflicts, protecting the already-published state.

All responses are no-store. Invalid body/path/query is
400 INVALID_SALES_ASSIGNMENT_REQUEST; missing/ineligible-role target
404 SALES_ASSIGNMENT_NOT_FOUND; stale/same-owner/ineligible-state change
409 SALES_ASSIGNMENT_CONFLICT; storage/audit/unconfirmed result
503 SALES_ASSIGNMENT_UNAVAILABLE. Existing session/role admission keeps its
401/403/503 envelopes. PUT requires uncompressed application/json bounded to
4 KiB (415/413 for media/size). Each administrator gets ten write attempts per
minute in a bounded 1000-entry process-local map (429 with Retry-After); four
writes can be in flight (503 on overload).

## Verification

`apps/api/test/admin-sales-assignments.test.mjs` exercises real SQL/JSON/HTTP and
existing sessions/policy/listing: role/capability/selector denial, initial and
replacement races, old/new access, retained primary/secondary history, inactive
recipients, suspended-company correction, create→assign→first-login onboarding,
Staff deactivation races, audit uncertainty and safe GET recovery, current
actor/company/staff changes after queue/lock waits, statement-wait expiry,
rollback, retained-history capacity boundaries, file interruption/reopen, corrupt
evidence and HTTP bounds/privacy.
Existing #34/#68 role/policy/listing tests also remain required. Implementer
self-verification does not replace independent acceptance review.
