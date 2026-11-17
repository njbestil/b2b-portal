# ADR-019: Transaction-bound submission snapshots

- Status: Proposed
- Related Issue: njbestil/b2b-portal#56

## Context

Submitted orders require durable historical product, price, UOM, MOQ, delivery and user values. Drafts currently hold only mutable commercial acknowledgements, and #62 owns the future submission transition. Re-reading master data after submission would rewrite history.

## Options considered

Creating snapshots after a transition risks partial or stale history. Reusing the mutable draft baseline omits delivery, user and product details. Adding an independent JSON snapshot file would introduce cross-file publication and recovery requirements.

## Decision

Build a detached, validated, exact-decimal versioned snapshot from trusted server values. SQL writes the order and item snapshots within a transaction owned by a component that receives the transition callback. JSON validates a caller-supplied transition and publishes it with the snapshot in the same order-file replacement under the shared coordinator. Existing snapshot evidence is never overwritten. The future #62 caller owns live validation, authorization, idempotency integration and the actual submission decision.

## Consequences and verification

No SQL migration or public route is introduced. SQL/JSON tests cover exact values, source changes, rollback, concurrent attempts, atomic publication, tenant mismatch and preservation of public summary projections. JSON retains its documented single-process and durability limits. This component does not reserve stock, send ERP requests or by itself make an order submittable. See [the component contract](../order-submission-snapshots.md).
