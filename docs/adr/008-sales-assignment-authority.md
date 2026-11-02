# ADR-008: Current primary Sales assignment authority

- **Status:** Proposed
- **Related Issue:** njbestil/b2b-portal#34

## Context

Frozen requirements limit Sales Staff to current assigned companies, with one
active primary owner. Role permission, customer tenant ownership and historical
order authorship do not prove current Sales assignment.

## Options considered

Client claims or session-lifetime cached assignments become stale after
reassignment. A selected-provider current-state check supplies bounded authority
without introducing assignment administration or a duplicate account model.

## Decision

Propose the private check and scope/internal-note composition described in
[sales-assignment-authorization.md](../sales-assignment-authorization.md). Reuse
the SQL table/indexes; validate equivalent private JSON evidence under the shared
coordinator. Missing/ended/non-primary/foreign evidence denies, corrupt evidence
fails closed, and current backend actor/role/state remain mandatory.

## Consequences and risks

Consumers must check every operation and scope before counts/paging/object reads.
Already admitted work may finish after reassignment. #84 owns writes; #68/#69 own
listing/detail. JSON authority is process-local/offline from catalog/reset, with
one shared coordinator for live writers. This does not grant access through
unintegrated HTTP routes.

## Migration / verification

No migration. Test two Sales users and companies with actual PostgreSQL/JSON,
reassignment, lifecycle, corrupted/duplicate evidence, internal-note privacy,
offline file handling and required failures. Independent acceptance is pending.
