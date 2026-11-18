# Sales Staff management (#83)

Normal authenticated Internal Admin uses the backend permission
`sales-staff.manage`. Sales Staff and customer roles cannot use these endpoints.
The composed administration UI is tracked separately in #88.

## Create

`POST /api/v1/admin/sales-staff`, exactly:

```json
{
  "displayName": "Synthetic Sales",
  "email": "sales@example.test",
  "temporaryPassword": "administrator-supplied temporary credential"
}
```

The administrator supplies and privately hands off the recipient's temporary
credential, following the existing Customer User provisioning contract. No
universal password, generated secret response, email/SMS channel or operator
artifact is introduced. Passwords are exact/untrimmed, nonempty and bounded to
1024 UTF-8 bytes, hashed by the existing asynchronous bounded scrypt producer.
Display name trims to nonblank text, maximum 160 UTF-16 code units. Email uses
the existing normalization and 254-character bound. Text controls and unpaired
surrogates are refused. IDs, role SALES_STAFF, companyId=null, status ACTIVE and
mustChangePassword=true are fixed by the server. Global normalized-email
uniqueness includes inactive accounts and all other roles/companies.

HTTP 201 returns the standard success envelope with `data.user` containing only
id, companyId, displayName, email, role, status and mustChangePassword.
No hash, password, reset proof or session proof is returned. Temporary login
remains restricted until the existing first-login password change succeeds,
revokes proofs and requires fresh login.

## Activate and deactivate

`POST /api/v1/admin/sales-staff/:id/deactivate` accepts exactly
`{"expectedStatus":"ACTIVE"}` (or SUSPENDED) and publishes DEACTIVATED.
`POST /api/v1/admin/sales-staff/:id/activate` accepts exactly
`{"expectedStatus":"DEACTIVATED"}` (or SUSPENDED) and publishes ACTIVE.
Same-state or Pending transitions are invalid; stale expected state is a 409.
A missing or non-Sales target shares one 404. Company-bound accounts are
ineligible. No caller-selected role, membership, deletion or password replacement
is supported. Both operations return HTTP 200 with the same safe DTO.

Both changes revoke every existing target session, preserve the password and
first-login flag, and require fresh login after activation. Deactivation retains
Sales assignments and historical records. Existing assignment policy checks the
current active account, so retained assignments grant no access while inactive.
After activation, fresh normal login may use still-current assignments. Reset
and session admission continue to follow their current active-account rules.

## Consistency and failure

Service access requires the existing opaque runtime actor capability. Each
provider rechecks current Internal Admin role, null company, ACTIVE status,
first-login flag, credential-bound unrevoked session, session hard expiry and
admitted access expiry under write ownership. PostgreSQL locks sorted actor and
eligible target users, then the actor session; user mutation and target session
revocation commit in one transaction. Expiry is checked again after statement
waits. Unique-index conflicts return 409. No schema migration is required.

JSON uses the shared security coordinator and refuses unresolved application
intents, preserving reserved-email safety. Users publish by atomic replacement.
Deactivation publishes inactive state before cleanup; activation cleans all old
sessions before publishing ACTIVE. Consequently an interrupted deactivation
cannot resurrect an old proof on activation. Current authority/expiry is checked
again before user publication. One trusted writer process per directory remains
required; offline directory changes require writers stopped.

Required post-publication audit actions are sales_staff.created,
sales_staff.activated and sales_staff.deactivated with actor, target, request ID
and outcome only. No display name, email or credential is audited/logged. An
audit failure returns 503 without undoing committed state. For a known target
ID, read `GET /api/v1/admin/users/:id/status` before retrying a lifecycle change.
Creation follows #41's committed-but-unconfirmed convention: an audit failure
may leave a created account even though the client received 503; retrying that
email conflicts. This API adds no staff directory or creation-recovery response.
JSON publication/cleanup failure may likewise leave a
committed inactive result; it remains fail-closed. There is no provider fallback.

Responses are no-store. No query selector is accepted. Invalid input returns
400 INVALID_SALES_STAFF_REQUEST; ineligible target 404 SALES_STAFF_NOT_FOUND;
duplicate/stale state 409 SALES_STAFF_CONFLICT; hash/storage/audit failure
503 SALES_STAFF_UNAVAILABLE. Session/role denial uses existing 401/403 envelopes.
HTTP requires uncompressed application/json, bounded to 8 KiB (415/413 for
media/size errors). Per administrator, ten attempts per minute use a bounded
1000-entry process-local map (429 + Retry-After); at most four management
requests run concurrently (503 on overload). The global password-work bound
also remains in force.

## Verification

`apps/api/test/sales-staff.test.mjs` exercises real SQL/JSON/session/HTTP paths:
first-login, four-role and forged-actor denial, fixed selectors, duplicate and
lifecycle races, inactive assignment denial and historical retention, proof
revocation, administrator changes during hash work, expiry after actual SQL
row/index lock waits, transaction rollback, JSON cleanup/publication interruption
and reopen, unresolved application intent, required audit/hash/storage failure,
private output, and HTTP bounds. This is implementer self-verification;
independent review remains required.
