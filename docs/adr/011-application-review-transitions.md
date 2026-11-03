# ADR-011: Application review transitions and effect uncertainty

- Status: Proposed
- Related Issue: njbestil/b2b-portal#38

## Context

The merged review UI needs a real decision producer over the complete Pending application bundle, with paired account states and truthful event outcomes.

## Options considered

A single distributed transaction across existing audit/notification ports would change their boundaries. Replaying an uncertain append could duplicate effects. Returning only an error after committing hides the canonical decision.

## Decision

Retain a private decision snapshot alongside paired company/initial-administrator transitions, using a SQL transaction or serialized recoverable JSON intent. Preserve submitted credentials and first-login-change state. Revalidate live Internal Admin/session authority at persistence. Accept replay of the identical original command; conflict on a different decision.

Persist independent effect states. Claim unknown before invoking an existing append port and mark completed only after confirmation. Unknown effects require reconciliation and are never blindly retried. Return canonical decision/effect states to the existing feature-owned UI.

## Consequences and risks

Migration 0006 adds a private SQL table; JSON adds private review/intent files and blocks security operations during incomplete publication. JSON is single-process storage. Effect append and state confirmation are separate commits; a successful append followed by failure to confirm remains unknown. No exactly-once or email delivery guarantee is introduced. Pending queue reads currently validate all eligible bundles before count/pagination, appropriate for the MVP but requiring query optimization if volume grows.

## Migration / verification

Apply the versioned migration normally. Test real PostgreSQL/JSON decisions, concurrent replay, role denial, stale authority, event failure and JSON interrupted-stage restart; run repository checks and verify Web binding. Independent PR review remains required.
