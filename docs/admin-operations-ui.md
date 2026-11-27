# Admin operations UI (#88 / B2B-076)

Normal Internal Admin accounts use the existing Customers, Sales Staff and ERP
Integrations destinations. Each page links System diagnostics at
`/operations/diagnostics`. Preview, customer, Sales and restricted accounts cannot
construct the Admin client. Existing Sales/customer destinations remain scoped to
their own feature issues. The supplied ZIP is the layout and interaction reference;
shared shell/tokens, feature CSS, native tables/forms/dialogs and heading focus are
retained. There is no Tailwind/dependency migration.

- Customers: paged directory, detail, company-profile link, fresh expected-state
  suspension/reactivation and primary assignment inspection/replacement. Active
  Sales recipients are paged and server-revalidated; pending first-login flags
  remain visible. No counts, credit fields or ERP values are invented.
- Sales Staff: paged safe directory, credential-free profile/status, explicit
  activation/deactivation and creation using a privately supplied temporary
  password. Passwords are cleared after an attempt and never persisted in browser
  storage or returned by the API. Unknown creation outcomes require checking the
  directory before another attempt. First-login policy remains unchanged.
- Integration monitoring: validated server filters, safe list/detail projection,
  technical status/count/times and fixed error categories. An eligible explicit
  retry uses the current retryCount/updatedAt. Confirmation triggers one command
  and a fresh read, not an optimistic ERP success. Unknown/business/in-flight
  outcomes have no retry action. No automatic command replay or polling.
- Diagnostics: actual selected-storage/database/ERP probe results, with explicit
  not-in-use/unconfigured/down states. Probes do not imply order success or switch
  providers. JSON monitoring/retry remains unavailable by the existing producer
  contract; the screen shows its controlled error rather than fake rows.

## Required support contracts

The merged Sales lifecycle producer lacked a directory read. This issue adds
GET `/api/v1/admin/sales-staff?offset=0&limit=20` under the existing
sales-staff.manage permission, without widening roles. Only null-company Sales
accounts are returned, sorted by UUID, with id/companyId/displayName/email/role/
status/mustChangePassword. No credential, session, assignment or arbitrary user
fields leave the service. Paging is canonical, limit 1–100, offset 0–100000;
unknown/repeated/invalid selectors fail. Current normal Internal Admin and bound
session/expiry are rechecked within the existing SQL transaction or JSON security
coordinator. SQL count/page share a query snapshot. Empty/beyond-end pages retain
the total. Reads do not mutate account data.

SessionClient and shared transport now admit PUT for the already-established
primary-assignment endpoint. They retain current normal access, cancellation,
no-store, fixed API paths and no automatic write replay. No new permission,
migration, source ownership or financial behavior is introduced.

## Verification

Actual SessionClient/AdminClient/HTTP JSON and PostgreSQL tests compose directory,
creation, assignments, status commands and diagnostics; stale versions/authority
and unavailable or unsafe retry behavior fail closed. Projection/markup tests
cover malformed/private data and recovery wording. Full combined and browser
results are recorded in the PR. Independent review remains required.
