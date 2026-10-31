# ADR-004: Credential-bound Bearer sessions

- Status: Accepted design — implementation review pending
- Related issue: [B2B-016 / #28](https://github.com/njbestil/b2b-portal/issues/28)
- Approval: [owner decision and PM readiness, 2026-10-31](https://github.com/njbestil/b2b-portal/issues/28#issuecomment-6546629943)

## Context

The frozen REST contract requires Bearer access/refresh authentication. ADR-003
already supplies bounded password verification. Sessions must use the selected
PostgreSQL/JSON provider, remain revocable and respect current account state and
first-login restrictions. This ADR records the approved producer contract; it is
not implementation QA, merge, secret provisioning or production migration approval.

## Options considered

- A profile returned by password verification is not reusable request proof.
- Stateless access alone would not provide the approved current-state admission.
- Credential-bound persisted sessions with signed access and rotating opaque
  refresh proofs satisfy the bounded MVP contract without another service.

## Decision

Use API-owned, pinned `jose` with fixed HS256 access signatures, explicit access
type/issuer/audience and locally configured key IDs. Each configured key contains
32–64 random bytes; no built-in or implicit ephemeral signing key exists.
Access lifetime is at most 15 minutes, capped to the absolute session expiry;
refresh lifetime is at most seven days without sliding extension. JWT validation
permits at most 30 seconds tolerance; persisted session expiry has no grace.

Access claims contain only issuer, audience, user/session IDs and integer times.
Current stored identity/role/company/must-change state populates the backend
principal after signature and coherent session/account validation. Normal-access
admission denies must-change users; restricted consumers must explicitly allow
their owning flow. Business role/company/object/assignment policy stays with its
owning issues.

Reuse the accepted password verifier and retain private verified credential
evidence only inside backend composition. Conditional session creation checks it
against current eligible account state. Persist the opaque refresh digest and a
separate private versioned credential fingerprint on the existing session entity.
Null/unrecognized fingerprints deny without live backfill. Credential changes
invalidate old bindings, including when later JSON session cleanup is interrupted.
No credential-derived field enters JWT, public DTOs, logs or audit metadata.

Refresh replaces only the current digest in one serialized operation. Exactly one
concurrent use wins; stale/invalid proof is rejected without session-family
compromise containment. This explicit MVP policy retains no consumed-token lineage;
it does not claim OAuth compliance or family replay detection. Clients serialize
refresh; a lost response can require fresh login.

SQL operations use one checked-out transaction connection, company then user then
session locking and current association checks. JSON uses one injected
single-process security coordinator per trusted directory for participating
session/account/credential operations, and atomic publication of each complete
private session file. Separate files are not a transaction. Later credential/status
writers must share the producer boundary; offline seed/reset/catalog swaps require
the API/writers stopped.

Persist before token disclosure. Required audit failures return unavailable/no
tokens while preserving any safe committed mutation. Audit is a separate port,
not part of the session transaction. Ambiguous commit failures are not retried or
represented as known rollback. Session revocation denies subsequent admission;
already admitted work is not cancelled.

## Consequences and risks

Session admission depends on storage availability; failures do not switch provider.
The backend principal is reusable by authorization consumers, not client-created
context. Existing unbound sessions require fresh login. JSON remains local/demo,
single-process storage with process-restart guarantees, not distributed or
power-loss durability. Refresh compromise containment beyond reject-only stale
proof requires separately approved design work.

Absent session configuration leaves operational login/refresh/current-user
authentication unavailable, without inventing a key or upgrading a safe profile
into a session. Partial/invalid configuration fails startup with setting-name-only
diagnostics. See [the session runbook](../sessions.md).

## Migration and verification

Append `0004_session_credential_binding.sql`; do not edit applied migrations.
Version 0003 is reserved by the parallel onboarding PR #132; sessions do not consume
its unmerged application behavior. Integration/release must reconcile version
order against merged main before applying migrations to reusable targets. Do not
apply 0004 ahead of a still-planned 0003 and later backfill history; renumber an
unapplied proposal before integration if the authorized integration order changes.
No production migration is performed by this issue.

Verify real SQL/JSON issuance, private projections, current-state denial,
credential-bound admission, single-winner rotation, revoke/refresh ordering,
post-wait hard expiry, legacy/unmigrated storage, publication/commit/audit failures,
process restart and offline private-file compatibility. Run focused tests and
`npm run check`; actual results belong in the PR, with explicit skips.
