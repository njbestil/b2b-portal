# Account suspension and explicit reactivation

Frozen requirements 2.2–2.3 deny business admission to suspended users and deny
customer-side admission when a company is suspended. Internal Admin retains
historical visibility. This feature preserves users, companies, orders, notes,
audit references, credentials and must-change flags.

## HTTP contract

Normal Internal Admin Bearer admission is required for GET and PATCH:

- /api/v1/admin/users/:id/status
- /api/v1/admin/companies/:id/status

GET accepts no query selectors and returns standard data
{target:{id,kind:"user"|"company",status}}. PATCH accepts exactly:

```json
{ "expectedStatus": "ACTIVE", "status": "SUSPENDED" }
```

The opposite SUSPENDED -> ACTIVE transition is explicit reactivation. No other
status pair or no-op is accepted. A stale expected state returns 409 STATUS_CONFLICT;
the client refreshes status rather than blindly retrying. This is not an
application approval, arbitrary activation, deactivation or user-provisioning
endpoint. Pending/rejected/deactivated targets are not silently revived.
Customer Admin's Customer User deactivation remains #41.

All successes use the same target shape and no-store envelope; no token/cookie
is issued. Self-status mutation is refused. Other Admin operations revalidate
current actors while holding ordered locks, so concurrent mutual suspension
cannot remove both currently active Admins through this API.

Errors: 400 INVALID_STATUS_REQUEST (shape/UUID/query/transition), 403 FORBIDDEN
(including self mutation), 404 ACCOUNT_NOT_FOUND, 409 STATUS_CONFLICT, and controlled
503 STATUS_UNAVAILABLE. Shared #28/#32 admission errors remain 401 INVALID_SESSION,
403 PASSWORD_CHANGE_REQUIRED/FORBIDDEN or 503 AUTH_UNAVAILABLE. PATCH JSON is
uncompressed and limited to 2 KiB; shared parser INVALID_JSON/413/415 semantics
apply. No client actor/role/status header supplies authority.

## State and session ordering

Each operation derives authority from #32's runtime actor, then rechecks its
current active Internal Admin identity, normal flag and credential-bound live
session in the repository boundary. After waits, revoked/expired/ineligible actor
proof cannot change state. Targets are resolved from current private records.

PostgreSQL uses one checked-out transaction: target company first (when relevant),
users in stable ID order, then actor session. It rechecks target membership after
locks, performs expected-state comparison, changes status and revokes affected
sessions together. Company changes revoke sessions for users bound to that
company; other companies and the acting Admin remain unaffected. Commit failure
is unconfirmed, never an automatic retry or asserted rollback.

JSON uses the shared security coordinator with session, credential and intake
writers. Suspension publishes the inactive status before session cleanup.
Reactivation clears all old affected sessions **before** publishing ACTIVE.
Failure or process termination between files therefore cannot revive old proof.
There is no cross-file transaction or power-loss durability claim.

Subsequent login/refresh/access admission checks current user/company state.
Already admitted work may finish. Reactivation never unrevoke sessions, clear a
must-change flag, alter a hash or mint proof: fresh login and any required #30
password change still apply. Existing #31 recovery evidence continues to use its
own current-state, binding, expiry and one-use rules; this feature does not create
a new recovery grant.

## Audit and failure recovery

Required user.suspended/user.reactivated/company.suspended/company.reactivated
events use backend actor/target IDs and fixed reason codes only. No password,
hash, token, request body or free-text credential handoff is logged.
Audit failure after a committed transition returns 503 and never restores the
previous state. Refresh the current status to determine the committed outcome.
A completed explicit reactivation may permit fresh login despite an unconfirmed
response; old sessions remain revoked. No automatic reactivation is performed.

## Scope and verification

Based on actual merged #28/#30/#31/#32. It does not consume unmerged #34, mutate
assignments or provision accounts. Existing stateful assignment consumers will
observe the same changed user/company state when integrated. Tenant route
integration remains a separate producer gate; no missing route is copied here.
No migration, deployment, production data operation or merge is included.

Tests use real PostgreSQL and JSON to cover suspended users and both company
customer roles, explicit activation/fresh-login behavior, preserved credentials/
flags/history, all-role guards and spoofed input, expected-state/mutual Admin
concurrency, post-lock actor checks, transaction/JSON publication/audit failures,
actual termination/reopen and safe HTTP envelopes/logs. Independent acceptance
remains required.
