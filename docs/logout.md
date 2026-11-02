# Logout

B2B-017 exposes the merged credential-bound session producer's current-session
revocation through POST `/api/v1/auth/logout`.

Send `Authorization: Bearer <accessToken>`, `Content-Type: application/json`
and exactly `{}`. The validated backend proof supplies the user and session;
client user, role, company or session selectors are rejected. Both normal and
first-login restricted users may log out.

Success is HTTP 200 with the standard envelope:

```json
{ "success": true, "data": { "loggedOut": true }, "requestId": "<request ID>" }
```

No token or cookie is issued. All responses are no-store. The client clears its
local proofs. Invalid/expired/revoked/ineligible proof returns generic
401 `INVALID_SESSION`; wrong body shape returns 400 `INVALID_SESSION_REQUEST`.
Unsupported media/encoding returns 415, oversized JSON 413, attempts exceeded
429 `LOGOUT_RATE_LIMITED` with Retry-After, and required storage/audit failure
503 `AUTH_UNAVAILABLE`. Missing session configuration is unavailable.

The endpoint permits 30 direct-peer attempts per minute, at most 1000 buckets
and eight in-flight requests per process. JSON is bounded to 4 KiB and compressed
bodies are refused. Forwarded IP headers do not control these buckets.

Only the active validated session is persistently revoked. Other sessions for
that user and other users remain unchanged. A later repeated HTTP request with
the revoked proof is 401. Concurrent requests already admitted before revocation
may both return success because the underlying persistence operation is
idempotent.

Subsequent backend access and refresh admissions deny the revoked session,
including after reopen. Signed access tokens retain their existing expiry, but
this API checks current persistent state on each admission; it does not rely
only on JWT expiry. Already-admitted work may finish, including a refresh that
returns proof which has become revoked before delivery. Consumers must handle
the next authentication denial.

The existing provider locks/coordinator and failure semantics remain in use.
A pre-commit publication failure is unavailable and may leave the old session
valid; a committed revocation is never restored after an audit/response failure.
Do not treat a 503 as confirmation of rollback. No migration, signing secret,
credential reset or UI is added. This branch consumes merged #28, independently
of #30's password-change endpoint; either PR can be reviewed on its own.

Tests use actual PostgreSQL and JSON adapters, isolated synthetic fixtures,
refresh/audit barriers, failed publication/transaction injection, reopen checks,
HTTP privacy and bounded admission. Run the focused logout/session suites and
`npm run check` with the documented B2B_TEST_* opt-ins on disposable targets.
