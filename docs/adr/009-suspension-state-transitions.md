# ADR-009: Serialized suspension and explicit reactivation

- **Status:** Proposed
- **Related Issue:** njbestil/b2b-portal#42

## Context

Frozen requirements already define suspended-user/customer-company denial and
Internal Admin historical visibility. Status writes must share the live-state
boundary used by session validation and preserve all historical records.

## Options considered

Client-only status flags or deleting accounts do not satisfy the requirements.
Publishing ACTIVE before cleanup could revive a surviving old session after a
failed suspension cleanup. Explicit expected-state transitions with safe
publication order reuse the approved stateful session producer.

## Decision

Propose the bounded Admin contract in [account-suspension.md](../account-suspension.md).
Allow only ACTIVE/SUSPENDED expected-state transitions; disallow self mutation.
Revalidate the actor/target under company/user/session ordering. SQL commits status
and session revocation together; JSON publishes inactive first on suspension and
clears old sessions first on activation. Never clear credentials/must-change or
mint new proof as a status side effect.

## Consequences and risks

Already admitted work may finish. Required audit failure after commit returns
unavailable without restoring state; callers refresh state before another action.
Pending approval, deactivation, assignment writes and provisioning remain separate.
This implements frozen requirements; independent implementation acceptance is
pending.

## Migration / verification

No migration. Verify actual provider parity, history, current proofs, lock waits,
concurrent transitions, interruption/publication/transaction/audit failures and
the four-role HTTP boundary. No production mutation or merge is authorized.
