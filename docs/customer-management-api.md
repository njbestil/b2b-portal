# Customer management API (#82)

Normal Internal Admin Bearer admission is required for
`GET /api/v1/admin/companies?offset=0&limit=20`. The directory retains every
company lifecycle state: Pending, Active, Suspended, Rejected and Deactivated.
Companies order by ID ascending, independent of names. The standard no-store
success envelope contains `{items,total,offset,limit}`; each item contains only
`id`, `legalName`, `tradeName`, `status` and `erpCustomerReference`. No contact,
credential, session, application bundle, assignment or commercial-field write
surface is added.

Offset is a canonical unsigned integer 0–100000 (default 0); limit is 1–100
(default 20). Unknown, repeated, nested, fractional or overflowing parameters
return 400 `INVALID_ADMIN_COMPANY_QUERY`. Empty and beyond-end pages retain the
matching total. Other roles receive 403; absent/expired/revoked authentication
uses the existing 401/403 admission errors. Required storage failure returns
503 `ADMIN_COMPANIES_UNAVAILABLE`, without provider switching or internal errors.

The service requires the backend-authorized runtime actor. Both adapters recheck
the current active normal Internal Admin account, credential-bound non-revoked
session, hard expiry and admitted access expiry before releasing data. PostgreSQL
reads authority, count and page in one parameterized statement snapshot and
checks expiry after pool/query waits. JSON holds the shared security coordinator
while reading checked company/account/session data and projecting count/page.
An already admitted operation may finish; no session-lifetime authority cache or
cross-provider fallback is introduced.

## Existing detail and lifecycle operations

Use `GET /api/v1/companies/:companyId` for the existing company summary/detail
projection. Internal Admin retains inactive-company historical visibility through
that contract. Existing company users, orders and profile reads remain under
their respective permissions and contracts.

Use the merged account-status endpoints for customer company suspension and
explicit reactivation:

- `GET /api/v1/admin/companies/:id/status`
- `PATCH /api/v1/admin/companies/:id/status` with exactly
  `{ "expectedStatus": "ACTIVE", "status": "SUSPENDED" }`, or the opposite pair.

The same account-status contract supports individual users at
`/api/v1/admin/users/:id/status`. These operations retain the existing expected
state conflict handling, credential/history preservation, session revocation and
required audit events. Reactivation requires fresh login and never restores old
sessions or clears a must-change-password flag. On a 503/unconfirmed response,
reload current status instead of assuming rollback or blindly retrying. See
[account suspension](account-suspension.md).

Pending companies are activated only through the existing
`POST /api/v1/admin/applications/:companyId/decision` approval flow, which also
activates the initial Customer Admin. Pending/Rejected/Deactivated accounts cannot
be revived by a status patch. See [application review](application-review-api.md).

No migrations, dependencies, ERP ownership changes or new status transitions are
required. #88 owns the composed admin UI. Independent review remains required.

## Verification

`apps/api/test/admin-companies.test.mjs` exercises JSON/PostgreSQL parity, all
lifecycle states, deterministic pagination, privacy, all-role and copied-actor
denial, current account/credential/session/access changes, coordinator/query
waits, unavailable stores and HTTP listing → suspension → conflict → explicit
reactivation with audit/session assertions. PostgreSQL uses the existing
`B2B_TEST_MIGRATIONS_DATABASE_URL` opt-in and isolated synthetic schemas.
