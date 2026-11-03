# ADR-014: Customer-owned draft header persistence

- Status: Proposed
- Related Issue: njbestil/b2b-portal#51

## Context

The frozen model has order/address tables and summary reads but no draft write capability. This issue authorizes customer-owned create/update/delete while items, submission and UI remain separate.

## Options considered

Putting SQL/JSON in handlers would bypass the existing port boundary. Reusing company-wide read scope for writes would allow same-company creator violations. Adding a second order store/version table would duplicate identity and require unnecessary migration. Cascading private/child history during deletion would remove data outside this slice.

## Decision

Add a private draft port behind authenticated creator-only service/router operations. Server owns identity/company/creator/timestamps and DRAFT/NOT_SENT state. The only mutable header field is a checked same-company active address reference. Canonical representation versions and monotonically advancing updatedAt guard concurrent writes. Preserve all non-DRAFT/submission evidence and refuse deletes with child references.

Reuse existing SQL columns/transactions and account-first lock ownership. Extend JSON order rows with optional address/updatedAt while retaining legacy summary data, preserving summary port projections and refusing unsupported private fields before publication. Serialize draft mutation and production internal-note publication through the same directory coordinator so deletion cannot race an orphan note. No notes permission change or item write is introduced.

## Consequences and risks

No migration or new dependency. JSON requires one trusted process, bounded atomic publication and offline maintenance. Create is not replay-idempotent; post-commit audit/transport failure requires reload rather than automatic write replay or rollback. Existing child references cause conflict; future item work must define cleanup/version behavior. There is no company order-history listing, item editor, ERP call, submitted snapshot, submission idempotency or Web change here.

## Verification

Real SQL/JSON owner/company/role/reference checks; non-DRAFT protection; concurrent edits/deletes; queued expiry including a real SQL lock wait; atomic publication/rollback; audit uncertainty; child-note deletion race; legacy cross-provider parity; safe projections and required repository checks. Independent review and owner acceptance remain required.
