# Bearer sessions

B2B-016 composes accepted credential verification with the startup-selected session
provider. Configure sessions explicitly; the API never provisions a signing key.

## Server configuration

| Setting                  | Meaning                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| AUTH_JWT_ISSUER          | Exact nonempty issuer                                                                            |
| AUTH_JWT_AUDIENCE        | Exact nonempty audience                                                                          |
| AUTH_JWT_ACTIVE_KID      | Active local key ID                                                                              |
| AUTH_JWT_KEYS            | Private JSON object mapping at most five local IDs to canonical base64url 32–64-byte random keys |
| AUTH_ACCESS_TTL_SECONDS  | 1–900 seconds, default 900                                                                       |
| AUTH_REFRESH_TTL_SECONDS | 1–604800 seconds, default 604800                                                                 |

Keep key settings in approved server-only environment/secret storage, never
frontend variables, source, logs or issue comments. Supply independently generated
random keys through the authorized operational process. This issue does not
provision them. Retain old verification keys through their final accepted token
expiry plus tolerance unless intentionally invalidating them. Unknown key IDs
deny; no token-directed network key lookup occurs.

All settings absent disables operational session authentication: login, refresh
and current-user return controlled 503 rather than issuing an unpersisted token or
returning a profile as a session. Partially supplied/invalid settings fail startup
with names/rules only. Existing direct credential-verifier tests still exercise
the underlying credential-only port; a verified profile grants no resource access.

When configured, storage health includes session capability. PostgreSQL with the
binding migration missing stays the selected provider but cannot authenticate;
there is no startup DDL or request-time JSON fallback. JSON missing
`user_sessions.json` means no prior sessions; missing users/companies or corrupt
existing session data is unavailable, never silently initialized.

## HTTP contract

`POST /api/v1/auth/login` retains exactly email/password input and the existing
4-KiB, encoding, direct-peer attempt and password-work bounds. A successful response
uses the standard envelope with `data.user` plus:

- `accessToken`, `refreshToken`, `tokenType: "Bearer"`
- `expiresIn` (whole seconds at issuance), `refreshExpiresAt` (fixed absolute time)

Send only the access token as an Authorization Bearer header. Tokens never belong
in query strings or logs; cookies are not used. Responses use no-store.

`POST /api/v1/auth/refresh` accepts exactly `{refreshToken}` as uncompressed
application/json, at most 4 KiB. It rotates the current opaque proof, preserving
session ID/creation/absolute expiry. Concurrent use has one winner; stale proof is
401 without a grace/recovery response or revocation on arbitrary mismatch.
Serialize refresh and use fresh login if a successful rotation response is lost.
The route permits 30 attempts per direct-peer minute with 1000 buckets and at most
eight concurrent refresh HTTP operations per process; trust proxy remains disabled.
These are per-process demo limits, not a distributed limiter.

`GET /api/v1/auth/me` validates access and current state and returns only user ID,
role, company ID and must-change state in the standard envelope. Duplicate or
ambiguous Authorization headers deny. Restricted first-login proof is 403 here;
normal business access requires password change. Refresh preserves restriction.
Password-change and logout HTTP endpoints remain #30/#29; the private session
producer already supports persistent revocation for those consumers.

Invalid/expired/revoked proof is 401, restricted normal access is 403, invalid body
shape is 400, oversized input 413, unsupported encoding/media 415, rate limit 429
and required storage/audit/capacity failure 503. Do not inspect internal errors to
derive account existence or retry consumed proof.

## Backend producer and persistence

`authenticateAccess(token)` returns only
`{userId, sessionId, role, companyId, mustChangePassword, accessExpiresAt}`.
Account, company, role and first-login status come from current validated storage,
not token role claims or client selectors. #32 owns role permissions, #33 company
and object scope, #34 Sales assignments. Their consumers must use the normal-access
guard before business permission checks.

The existing session table gains nullable private `credential_fingerprint`;
legacy/unknown bindings deny without backfill. Binding uses a fixed domain/version
and unambiguous framing of immutable lowercase user ID plus exact accepted encoded
credential. Refresh references remain separate SHA-256 digests of high-entropy
opaque proofs, not password hashes. No new password-hashing policy is introduced.

SQL account-first transactions and the injected JSON security coordinator define
admission ordering. Future credential/account writers must use the same boundary;
do not instantiate another coordinator for the same live directory or compose
separate collection reads/replaces as a transaction. JSON reads fresh records and
publishes complete private session arrays by exclusive temporary write/sync/rename.
Its capacity is 10000 rows and 10 MiB; exceeding it fails unavailable rather than
silently deleting security state. No automatic retention purge is implemented.

Required `session.issued`, `session.refreshed` and `session.revoked` audit outcomes
record safe IDs only. Credential-login success is separate from session issuance
and token delivery. A later audit/disclosure failure does not undo committed
rotation/revocation. An ambiguous SQL commit is unavailable without automatic
retry. Already admitted work may finish after a concurrent revoke; subsequent
access/refresh admission denies. Access JWTs never outlive the hard session cap.

Later #30/#31 credential changes must publish the fresh credential and must-change
flag together before JSON session cleanup. Restart then rejects old bindings even
if cleanup never completed; do not restore the old credential on cleanup failure.
That workflow is not implemented in #28.

Offline catalog refresh preserves session bytes. Explicit confirmed disposable
demo reset can clear the known private session file; unknown files, links and
unsafe targets remain refused. Stop the API and all writers before either action.

## Verification

Build, then run the focused session/credential suites and root check with the
documented database opt-ins pointed only at an owned disposable target:

```powershell
npm run build
node --test --test-concurrency=1 apps/api/test/sessions.test.mjs apps/api/test/login.test.mjs
npm run check
```

Absent SQL opt-ins explicitly skip actual-provider tests and do not establish
parity. Session tests use synthetic credentials/keys and barriers rather than
sleep-based race claims. No test secret is a usable operational account/key.
