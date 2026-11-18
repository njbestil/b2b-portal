# ADR-021: Internal Admin Sales Staff lifecycle

- Status: Proposed
- Related issue: njbestil/b2b-portal#83
- Foundations: existing role enforcement, credential-bound sessions, first-login
  password change, suspension and Customer User provisioning contracts

## Context and options

Internal Admin must create, activate and deactivate Sales Staff. Generic customer
provisioning grants the wrong role/company scope; generic suspension excludes
DEACTIVATED. Reusing either mutation unchanged would violate its contract.

## Decision

Use a dedicated fixed-role/null-company management port with the existing opaque
actor, selected storage, bounded temporary credential and first-login producers.
Require optimistic expected-status transitions. Preserve credentials, assignments
and historical references. Every lifecycle change revokes target sessions; current
inactive-account admission denies assigned-company access. Fresh normal login
can use retained current assignments after activation.

Reuse SQL user/session lock order and transactions. JSON uses its shared writer
coordinator, publishes inactive state before cleanup, and cleans old sessions
before activating, including recovery after interrupted deactivation cleanup.
Recheck current actor/session authority and expiry under provider write ownership.
Use required safe post-publication audit with an unconfirmed-result 503 if audit
fails. No public secrets, new credential model, migration, delivery dependency,
UI or deployment is introduced.

## Consequences and verification

Reactivation is intentionally specific to eligible Sales Staff and does not
change customer deactivation semantics. JSON remains per-file atomic rather than
a distributed transaction; interrupted activation cleanup leaves the target
inactive. Existing assignment owners retain responsibility for reassignment.
Tests cover actual SQL/JSON, sessions, HTTP, races, lock waits, rollback,
interrupted publication, restart and privacy. Proposed status awaits independent
review and any required owner approval; this ADR implies no merge/deployment
approval.
