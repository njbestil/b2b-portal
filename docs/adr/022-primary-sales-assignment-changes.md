# ADR-022: Atomic primary Sales assignment changes

- Status: Proposed
- Related issue: njbestil/b2b-portal#84
- Foundations: ADR-008 current assignment policy and ADR-021 Staff lifecycle

## Context and alternatives

Internal Admin must assign/reassign Sales Staff while preserving exactly one
active primary owner for the resulting assigned company. The existing #34 port
is read/policy-only. Adding caller-controlled ownership to a session or ending
history separately from creation could leave stale grants or partial ownership.

## Decision

Use a separate Internal Admin administration capability with GET current owner
and PUT guarded by expectedAssignmentId (null for an initial assignment).
Derive creator, IDs, timestamps and active/primary flags on the server. Reject
stale/same-owner changes. Atomically end prior active company rows and append one
new active primary, preserving every prior row. No unassign/delete flow is added.

Recipients must be current ACTIVE/null-company Sales Staff; first-login
restriction does not prevent assignment, so #83 create→assign onboarding works.
Existing #34 still denies assignment use until password change/fresh normal
login. Administrative changes permit ACTIVE/SUSPENDED companies; suspension
continues to block Sales access. Pending/rejected/deactivated companies are
ineligible. An inactive prior owner may be reassigned away.

Reuse company→sorted users→actor session→assignment SQL lock order, existing
partial unique indexes and one transaction. The company lock serializes empty
initial assignment state. JSON shares the security coordinator and existing
private file model; stage/sync one validated complete replacement and recheck
expiry before publication. Current Internal Admin/session/company/recipient
state is checked under write ownership. Preserve #34's interface and per-operation
policy, so the next operation observes old-owner denial/new-owner authority.
Required safe audit is post-publication and may yield an unconfirmed committed
503; GET current assignment before retrying.

## Consequences and verification

No migration, new role, dependency, credentials, delivery channel or UI is added.
JSON retains its bounded global private file and single-process writer constraint;
SQL administration bounds company history reads. No history truncation or provider
fallback is allowed. Already-admitted work may finish after reassignment. Test
actual SQL/JSON, concurrency, history, lifecycle/onboarding, old/new visibility,
queue/statement waits, rollback, atomic publication interruption and privacy.
This ADR remains Proposed pending owner/reviewer acceptance; no merge or
production approval is implied.
