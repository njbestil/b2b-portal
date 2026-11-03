# ADR-013: Portal-owned company profile updates

- Status: Proposed
- Related Issue: njbestil/b2b-portal#39

## Context

The existing UI separates five editable portal fields from readonly legal/licence/lifecycle/ERP information, but its producer was absent.

## Options considered

Writing submitted application fields would rewrite historical evidence. Duplicating commercial authority in a portal editor would violate the frozen ownership boundary. A separate profile/version table is unnecessary for the current bounded representation.

## Decision

Implement own-company read/PATCH and authorized internal read-only routes, rechecking live account/session/company/assignment authority at persistence. PATCH accepts exactly the five portal fields plus a full-representation precondition and returns a canonical profile. Readonly fields cannot be written. Use existing SQL columns and a transaction. JSON retains original application data and adds a checked portal override under the existing shared coordinator and atomic store. Preserve readonly source metadata and approval snapshots.

## Consequences and risks

No migration, dependency, ERP lookup or new role policy. A no-op save may retain its version; readonly source changes invalidate the prior representation. An unconfirmed publication requires reload. JSON remains single-process storage with offline maintenance. Missing readonly source values stay null rather than fabricated.

## Verification

Real PostgreSQL/JSON normalization/nulls, ownership, role/tenant/assignment, concurrent versions, atomic failure and original application/decision preservation tests; required repository checks. Developer B owns the separate Web binding, with integration acceptance after both layers merge. Independent review remains required.
