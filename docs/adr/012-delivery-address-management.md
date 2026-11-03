# ADR-012: Company-scoped address management

- Status: Proposed
- Related Issue: njbestil/b2b-portal#40

## Context

The merged address UI needs a producer enforcing Customer Admin management and active-only Customer User selection without duplicating Web work or extending order scope.

## Options considered

A separate version table/migration would complicate independent integration and create persisted metadata for a bounded representation. Reusing the existing address JSON and locking the company allows atomic management without changing the physical schema. Deleting inactive rows would break history and order references.

## Decision

Use shared own-company read/command routes and an internal read-only route. Revalidate backend role, account, credential-bound session and current Sales assignment at persistence. Retain inactive history and normalize absent legacy contacts to null. Store contacts in existing SQL address JSON and optional JSON row fields; update intake/recovery validation together.

Use a full canonical collection representation hash as the opaque precondition, with a 200-address cap including history. PostgreSQL serializes via company/user/session/address locks and transaction; JSON uses the shared coordinator and atomic single-file publication. Explicit replacement or clearing controls default deactivation. Activation never assigns a default implicitly.

## Consequences and risks

No migration or new dependency. A no-op update may keep its version; returning to an identical representation restores the same precondition. This is not a command ledger. Unconfirmed publication requires reload. JSON remains single-process storage with offline maintenance. Order consumers must independently validate active same-company address selection at their own mutation/submission boundary.

## Verification

Real JSON/PostgreSQL role/tenant/assignment, concurrency, default transitions, intake compatibility and failure tests; repository checks. Developer B owns the separate Web binding and integrated browser acceptance after both layers merge. Independent review remains required.
