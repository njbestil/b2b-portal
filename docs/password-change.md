# First-login password change

B2B-018 completes the owner-approved first-login workflow over the merged
credential-bound session producer (#28 / PR #136). UI belongs to #35.

## HTTP contract

POST `/api/v1/auth/change-password` requires an access Bearer token and exactly:

```json
{ "currentPassword": "<temporary password>", "newPassword": "<new password>" }
```

The account must currently require password change. The backend checks current
account/session eligibility and the exact current credential; a client flag,
role/company ID or confirmation field is not accepted as proof.

New passwords follow the approved product form: at least eight Unicode characters,
an uppercase letter, a number and a punctuation/symbol character, bounded by the
existing 1024 UTF-8-byte primitive. The new password must differ from the current
one. Neither password is trimmed or truncated; client confirmation is a UI check
and does not replace server validation.

Success is standard no-store JSON with `data: {requiresLogin: true}`, no token or
cookie. The client clears old session state and signs in with the new password.
All previous sessions for that user deny subsequent access/refresh admission;
another user's sessions remain unchanged.

| Outcome                                       | HTTP / code                                     |
| --------------------------------------------- | ----------------------------------------------- |
| Invalid shape/password policy                 | 400 / INVALID_PASSWORD_CHANGE                   |
| Invalid current password                      | 401 / INVALID_CREDENTIALS                       |
| Invalid, expired, revoked or ineligible proof | 401 / INVALID_SESSION                           |
| Already normal account                        | 409 / PASSWORD_CHANGE_NOT_REQUIRED              |
| Unsupported media/encoding or oversized JSON  | 415 or 413                                      |
| Attempts exceeded                             | 429 / PASSWORD_CHANGE_RATE_LIMITED, Retry-After |
| Required hashing/storage/audit failure        | Controlled 503                                  |

The uncompressed JSON limit is 4 KiB. Ten attempts per direct-peer minute, at most
1000 buckets and two concurrent HTTP operations per process bound this flow.
Existing password work remains process-bounded without an unbounded hash queue.
Session configuration absent means unavailable; no key or operational credential
is provisioned by this feature.

## Persistence and failure semantics

Password work occurs outside the shared critical section. The commit rechecks the
exact credential/session binding, current eligibility and must-change condition.
Concurrent changes verified against the same old state have one winner.

PostgreSQL uses the existing account-first checked-out transaction connection to
change hash/flag and revoke all user sessions together. A later revocation write
failure rolls back the same transaction. Ambiguous commit is unavailable, never a
claim of rollback or permission to retry a mutation blindly.

JSON uses the same injected security coordinator as session operations. It
publishes the new encoded credential and false must-change flag in one complete
users-file replacement **before** session-file cleanup. If cleanup fails or the
process stops afterward, old persisted bindings still deny after restart. There
is no users/sessions cross-file transaction or power-loss durability claim.
Before credential publication, the old complete state remains restricted and
usable only for its allowed flow. Never restore the old credential to recover
failed cleanup.

A required `password.changed` audit records safe actor/target IDs only. Wrong
current credentials record a safe denial event. No password, hash, token,
fingerprint or request-body content belongs in audit/logs/public projections.
Audit/cleanup failure after credential commit returns 503/no proof and preserves
the safe new credential. The password may already be changed: fresh login with
the new password is the recovery path; the API does not silently undo it.

No migration is added. The session binding migration comes from merged #28.
The shared session-file/account readers were factored for this writer rather
than duplicated. Future onboarding/lifecycle user writers must use the same
security boundary; #132's independently developed metadata/registration must be
preserved when integrating. This branch does not consume unmerged onboarding.

## Verification

Run `npm run build`, then the password-change/session suites and root check using
the documented B2B_TEST_* opt-ins only on owned disposable PostgreSQL targets.
Tests use synthetic credentials/keys, deterministic concurrency barriers, actual
SQL rollback, filesystem failure injection and child-process publication
acknowledgements before termination. Explicit SQL skips do not prove parity.
