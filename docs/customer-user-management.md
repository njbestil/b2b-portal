# Customer User management (#41)

Only a normal authenticated Customer Admin can use these own-company endpoints.
The server fixes company, role and lifecycle values. Customer User, Sales Staff
and Internal Admin cannot use this customer-scoped management API. Existing
company directory reads remain separate.

## Create

`POST /api/v1/customer-users`, uncompressed JSON, exactly:

```json
{
  "displayName": "Synthetic person",
  "email": "person@example.test",
  "temporaryPassword": "administrator-supplied temporary credential"
}
```

The temporary credential is supplied by the authorized administrator, using the
bounded password-input pattern already used by customer applications. This API
does not generate, return, mail or place a secret in a notification. The
administrator handles its intended recipient's credential handoff separately.
This feature adds no email/SMS delivery service.

Display name trims to nonblank text, maximum 160 UTF-16 code units; email uses
the existing normalized-email rule and 254-character input bound. Text controls
and unpaired surrogates are refused. Passwords remain exact and untrimmed,
nonempty and at most 1024 UTF-8 bytes, using the accepted bounded asynchronous
scrypt hasher. User IDs are generated server-side. Global normalized-email
uniqueness includes accounts in other companies and inactive/Pending accounts.

Creation publishes an ACTIVE CUSTOMER_USER with mustChangePassword=true.
Temporary-password login uses the existing restricted session; business access
remains denied until the existing first-login password-change flow succeeds,
revokes the old proofs and requires fresh login. Provisioning does not call the
credential-update helper, which would incorrectly clear the first-login flag.

HTTP 201 returns the standard success envelope with `data.user`:
`id, companyId, displayName, email, role, status, mustChangePassword`.
There is no password/hash/session/reset proof in this DTO.

## Deactivate

`POST /api/v1/customer-users/:id/deactivate`, exactly:

```json
{ "expectedStatus": "ACTIVE" }
```

Expected status may be ACTIVE or SUSPENDED. Only an own-company Customer User
in that exact state can transition to DEACTIVATED. A stale/already-deactivated
target conflicts; missing, foreign and ineligible-role targets share one 404.
No Customer Admin, internal account, role change, deletion, reactivation,
Pending approval or credential replacement is allowed. HTTP 200 returns the
same safe DTO. Legacy JSON users without an email return email=null.

Deactivation retains credentials, first-login flags and historical references,
and revokes all target sessions. Active/session/reset admission also checks the
current inactive account, so an interrupted revocation cleanup cannot restore
business access. Historical orders and audits remain intact.

## Authorization, consistency and failure

An opaque #32 actor capability is required by the service. Both adapters
recheck current Customer Admin role, own-company membership, account/company
status, first-login flag, session revocation/credential binding, session hard
expiry and admitted access expiry after acquiring write ownership. A suspended,
reassigned, restricted, reset or revoked administrator cannot complete a
previously admitted creation after password work or a lock wait.

PostgreSQL uses company-share, sorted in-scope user and actor-session locks;
creation/target changes and revocation share one transaction. Unique-index waits
are followed by another expiry check before commit. Foreign target rows are
neither projected nor locked. JSON shares the security coordinator with session,
credential, lifecycle and application writers. New writers refuse an unresolved
application intent so they cannot claim a reserved email. Users publish with an
atomic file replacement; on deactivation the inactive state publishes before
session cleanup. Offline directory swaps still require all writers stopped.

Required audit events are user.created and user.deactivated with actor,
company, target ID, request ID and outcome only. Audit runs after publication.
An audit failure returns 503 without undoing an already committed result;
refresh user data before retrying. No secret, email or display name is added to
audit metadata or request logs. Broader business notification integration is
separate.

All responses are no-store. No query selectors are accepted. Unsupported input
is 400 INVALID_CUSTOMER_USER_REQUEST; role denial 403 FORBIDDEN; missing target
404 CUSTOMER_USER_NOT_FOUND; duplicate/stale state 409 CUSTOMER_USER_CONFLICT;
required storage/hash/audit failure 503 CUSTOMER_USER_UNAVAILABLE. Existing
session admission errors retain their current 401/403/503 envelopes.

HTTP parsing is bounded to 8 KiB with no decompression. Media errors are 415,
oversized bodies 413. Per normal administrator, ten attempts per minute are
admitted in a bounded 1000-entry process-local map; excess attempts return 429
with Retry-After. Four management requests can be in flight; overload is 503.
The existing global password-work bound remains in force. No provider fallback,
implicit account seed or migration is introduced.

## Verification

`apps/api/test/customer-users.test.mjs` uses actual credentials, sessions,
password change and HTTP with PostgreSQL/JSON. It covers both companies/all
roles, restricted temporary credentials, duplicate races, foreign/role selectors,
deactivation/history, actor changes during hash work, expiry after actual SQL
lock waits, rollback, JSON publication/cleanup/reopen behavior, application-intent
refusal, required audit failures, response privacy and HTTP limits.
