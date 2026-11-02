# Local demo password recovery

Owner-approved recovery uses a verified local operator handoff, without an email
provider. [Approval](https://github.com/njbestil/b2b-portal/issues/31#issuecomment-6546630187).
The operator verifies the recipient through the demo's established human process;
the software acknowledgement records that verification has occurred and does not
automate identity verification.

## Consumer contract

POST `/api/v1/auth/forgot-password`, JSON exactly `{email}`, returns 202 with
standard data `{received:true}` for every syntactically valid email. It performs
the same anonymous audit work without account lookup or token issuance. The user
must contact the demo operator for verification and protected handoff. This receipt
does not promise delivery, a queued email or an operator notification.

POST `/api/v1/auth/reset-password`, JSON exactly `{token,newPassword}`, returns
200 with standard data `{requiresLogin:true}`. No session/token/cookie is issued;
clear prior proofs and sign in again. Manual proof input belongs in the body,
never a URL, local storage, logs or analytics.

New password policy is shared with #30: 8+ Unicode characters, uppercase letter,
number and punctuation/symbol, at most 1024 UTF-8 bytes; no trim or truncation.
The current credential cannot be reused.

Both routes use standard success/failure envelopes with requestId and no-store.
Invalid shape, policy or proof encoding is 400 INVALID_RESET_REQUEST; valid-format
but unknown/expired/used/ineligible proof is 401 INVALID_RESET_TOKEN; required
failure is 503 RESET_UNAVAILABLE. Parser errors retain shared INVALID_JSON/413/415.
Ten direct-peer attempts per minute are shared by both routes, with 1000 buckets,
two in-flight operations, uncompressed JSON limited to 4 KiB and 429
RESET_RATE_LIMITED with Retry-After. Forwarded IP claims do not control buckets.

## Operator handoff

Build first. Enable `AUTH_LOCAL_RESET_ENABLED=true` explicitly in a local demo
environment; production mode refuses this command. Provision an existing operator
directory using the operating system's normal protection workflow. POSIX requires
current owner and no group/other access. Windows allows only the current identity,
SYSTEM and Administrators in the DACL, with a trusted owner. The command checks
protection, refuses links/aliases and existing output, and never weakens permissions.
An unavailable ACL checker refuses delivery.

From the repository root, run the following template only after recipient identity
verification and with the correct dedicated demo target:

```text
npm run reset:issue --workspace=@b2b-portal/api -- --provider json --directory <absolute-b2b_demo_name-path> --confirm-target <same-absolute-path> --offline --identity-verified --email <verified-email> --output <protected-directory/new-proof.json>
```

For JSON, stop the API and all writers before invoking; acknowledge this with
`--offline`, then restart after issuance. The shared coordinator is process-local.
For PostgreSQL use `--provider postgresql --confirm-target b2b_demo_name` and omit
directory/offline; the configured database and actual server must be loopback.
No provider fallback occurs in this command. Both providers require dedicated
`b2b_demo_*` target names. No operational secret or real handoff is created by
building or testing this feature.

Only the exclusive protected artifact contains usable proof and expiry. Console
output is only reset.handoff_completed or reset.handoff_failed; no proof/email.
The operator transfers it through the approved protected channel and removes the
artifact afterward. This command does not send a message or implement an external
channel. Unknown/ineligible recipients refuse issuance. A new issue supersedes
earlier outstanding proof for that user.

## Persistence and failures

Proof has 32 random bytes and a 30-minute absolute expiry. Only its SHA-256 digest
and a private current-credential fingerprint are stored. No plaintext proof enters
the reset repository. Migration 0005 adds nullable binding; legacy unbound rows
remain unusable with no backfill. Migration files 0001–0004 are unchanged.

Redemption rechecks account/company eligibility, expiry, unused evidence and exact
credential state after hashing. PostgreSQL uses the existing account-first locks
and one transaction for credential/flag, all-session revocation and token
consumption. JSON uses the same coordinator and credential publisher as #30:
credential/flag are published before session/token cleanup. A changed credential
invalidates old reset/session bindings after process restart even if cleanup fails.
There is no cross-file transaction or power-loss durability claim.

Required audit/delivery/storage failures return controlled failure and never undo
committed credentials, consumed proof or revoked sessions. A 503 may follow a
completed reset: try fresh login with the new password; do not blindly repeat the
mutation. Failed issuance/audit/delivery may retain an undelivered hashed record;
operator reissue supersedes it. The HTTP API never exposes the retained proof.
Normal startup readiness checks reset capability and never switches providers
after a selected-provider failure.

## Verification and dependencies

Depends on merged #28/#30 (#136/#141); logout #142 is also merged. This PR targets
fresh main and includes no unmerged predecessor diff. No email service, migration
execution outside disposable tests, deployment or secret provisioning is included.
Tests cover actual PostgreSQL/JSON one-use, concurrent full password work,
expiry/legacy binding, previous credential changes, transaction/publication/audit
failures, process termination/reopen, protected local synthetic artifacts and HTTP
privacy/bounds. Independent review remains required.
