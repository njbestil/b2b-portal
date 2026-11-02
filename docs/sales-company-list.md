# Sales assigned-company listing (#68)

`GET /api/v1/sales/companies?offset=0&limit=20` requires a normal authenticated
Sales Staff account. The server derives staff/session identity exclusively from
the verified actor. Internal Admin and both customer roles cannot use this
Sales-specific endpoint. Role/company/staff selectors are refused; spoofed
identity headers grant nothing.

Success is the standard no-store envelope with:

```json
{
  "items": [],
  "total": 0,
  "offset": 0,
  "limit": 20
}
```

Each company has only id, legalName, tradeName, status and
erpCustomerReference. No assignment history/administration, intake contact data,
credentials, session fields, unassigned company details or unfiltered counts are
returned. The service validates page/cardinality, active status, unique IDs and
deterministic ordering before projecting its allowlist.

Offset is a canonical unsigned integer 0–100000, default 0; limit is 1–100,
default 20. Unknown/repeated/object/fractional/overflow query values return
400 INVALID_SALES_COMPANY_QUERY. Companies order by ID ascending, including
identical-name ties. Beyond-end pages are empty and retain the eligible total.

## Current assignment policy

Reuse #34's reviewed policy, not a new interpretation of assignment ownership.
A grant requires the current actor to be active, normal Sales Staff with no
company binding, and a current active primary assignment to an ACTIVE company.
The assignment must have no ended timestamp and must not start in the future.
Ended/inactive/nonprimary/future, foreign and unassigned rows grant nothing.
Suspended/Pending/Rejected/Deactivated companies do not count.

Assignment reassignment/end and current actor lifecycle/credential changes apply
to the next read; authority is never cached for a session lifetime. Both adapters
check the admitted access expiry and current credential-bound, non-revoked
session hard expiry before releasing data. Structural/copied actor objects
cannot call the protected service.

PostgreSQL reads actor/session, assignment integrity, eligible matches, total
and page in one coherent parameterized statement. Authority and expiry are
checked after query/pool waits. Assignment start time uses the operation's
sampled clock; there is no future-start grant. Duplicate active primary/pair or
active-ended inconsistencies fail closed before any page or count is exposed.
The existing schema/constraints/indexes are reused.

JSON holds the shared security coordinator while reading checked assignments,
users, companies and session state and producing count/page. The existing 2 MiB
assignment-file and 10000-row bounds remain. A missing assignment file means an
empty grant set, never all companies. Corrupt, oversized, linked or invalid
source data returns unavailable. No source or grant is created implicitly.

With sessions configured, API composition now requires assignment readiness.
An empty valid source remains ready; a corrupt/missing SQL schema does not.
Required storage failure returns 503 SALES_COMPANIES_UNAVAILABLE and never
reselects another provider. Existing 401/403/503 session admission envelopes
remain; a current non-Sales role is 403 FORBIDDEN. No internal errors are
reflected.

This API is listing only. #69 owns Sales customer detail, #75 owns Sales UI and
#84 owns assignment writes. Existing tenant-detail reads still fail closed for
Sales until their separate consumer wiring is delivered. This issue does not
grant new detail/mutation access or depend on the independent #41/#163 PRs.

## Verification

`apps/api/test/sales-companies.test.mjs` exercises actual PostgreSQL/JSON and
HTTP with two Sales owners and four companies. It covers filtering before
count/page, identical-name ties, empty/beyond-end bounds, nonprimary/future/ended
and reassigned rows, suspended companies, all roles, copied actors, current
credential/session/lifecycle changes, actual coordinator/pool waits, corrupt or
absent JSON, SQL integrity/table loss and explicit response privacy.
Run with the existing assignment and authorization suites plus npm run check.
