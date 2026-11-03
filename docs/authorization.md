# Backend role permissions

The frozen requirements sections 2.2–2.3 define four roles. Backend permissions
come from #28's current validated principal, never the role-preview UI, role
headers, company headers or a serialized login profile.

| Operation             | Internal Admin | Sales Staff   | Customer Admin   | Customer User    |
| --------------------- | -------------- | ------------- | ---------------- | ---------------- |
| profile.read          | yes            | yes           | yes              | yes              |
| company.read          | yes            | yes, assigned | yes, own company | yes, own company |
| catalog.read          | yes            | yes, assigned | yes, own company | yes, own company |
| orders.read           | yes            | yes, assigned | yes, own company | yes, own company |
| customer-users.read   | yes            | yes, assigned | yes, own company | no               |
| customer-users.manage | no             | no            | yes, own company | no               |
| applications.read     | yes            | no            | no               | no               |
| accounts.status.read  | yes            | no            | no               | no               |
| accounts.status.write | yes            | no            | no               | no               |
| sales.companies.read  | no             | yes, assigned | no               | no               |

These cover existing read projections, bounded #42 status transitions and #41's
own-company Customer User creation/deactivation. The customer-scoped management
permission does not grant Internal Admin lifecycle operations, role changes,
ERP commercial writes, integration retries, application decisions or order
mutations. Unlisted operations/unknown roles deny by default.
Customer User cannot manage the directory. The customer directory
projection includes only customer-role profiles, never credentials/internal staff.

Role permission is necessary but does not grant company, object or Sales
assignment ownership. #33 applies company/object scoping to the existing read
ports; #34 separately owns Sales assignment checks. Sales ownership must remain
fail-closed without that producer. Do not wire the raw scope-accepting query
services directly to HTTP.

## Enforcement

#68's Sales listing uses the dedicated sales.companies.read permission and
current #34 assignment policy before totals/pagination. See
[Sales assigned-company listing](sales-company-list.md). It does not enable
Sales detail/mutation access merely because company.read is role-allowed.

The pure authorization service admits an immutable actor only through injected
#28 validation, checks the normal-account restriction and role permission, and
records a private runtime capability. Protected services call requirePermission
again. Structural/copy/serialized actor objects fail the capability check.
Middleware keeps that actor in a request-keyed WeakMap; caller input/res.locals
does not create it. Actors are request-scoped and must not be persisted or reused
as an alternative to fresh session admission.

GET /api/v1/auth/me uses profile.read and retains its existing data.user shape.
GET /api/v1/admin/applications/:companyId uses applications.read and returns
standard data {application:<PendingApplication>} only for a complete Pending
bundle. The projection is the existing checked #36 fields, without password/hash.
This is a read endpoint, not an approval/rejection operation. No list or decision
endpoint is invented here. Invalid UUID/query selectors return 400
INVALID_APPLICATION_QUERY; absent/non-Pending bundle is 404 APPLICATION_NOT_FOUND;
unavailable repository is 503 APPLICATION_REVIEW_UNAVAILABLE.

Standard no-store envelopes apply. Unauthenticated/bad/expired/revoked/ineligible
sessions return 401 INVALID_SESSION; first-login restriction 403
PASSWORD_CHANGE_REQUIRED; role denial 403 FORBIDDEN; required admission failure
503 AUTH_UNAVAILABLE. Missing configured producer/capability never grants access.
Already-admitted reads may finish; each new HTTP request rechecks backend state.
#41 additionally rechecks current authority inside provider write ownership,
including access expiry after SQL statement waits.

Anonymous Pending application intake and purpose-specific login/refresh/password/
logout flows retain their existing independent validation. Root service identity
and health expose no business data and remain public. No migration, new role,
fixture identity shortcut or signing secret is introduced.

## Verification

Tests cover the declared operation/four-role matrix plus unknown roles/permissions,
immutable capability/serialized-profile refusal, actual PostgreSQL and JSON
sessions, live role changes, first-login/inactive/expiry/revocation, header
spoofing, unavailable producer/repository, redacted responses/logs and existing
session regressions. Self-review does not replace independent acceptance.
