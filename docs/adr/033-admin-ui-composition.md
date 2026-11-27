# ADR 033: Admin UI composition and bounded Sales directory

Status: Proposed
Related: njbestil/b2b-portal#88

## Context

The operations UI must use the merged customer, Sales lifecycle, assignment,
monitor/retry and diagnostics contracts. Sales lifecycle did not include a
read directory, and the normal web transport did not yet support assignment PUT.

## Decision

Keep the current feature/CSS architecture and compose the existing APIs with
strict public projections, cancellable reads and explicit versioned commands.
Add only a bounded Sales directory under existing sales-staff.manage authority,
using the existing provider account/session ownership checks. Extend the web
method allowlist to support the existing PUT assignment operation without replay.

Use native confirmation dialogs for account/retry changes and native labelled
forms. After a successful status command refresh the directory; after uncertain
writes require a current read. Do not synthesize ERP/financial/health values or
unsupported JSON monitor/retry behavior from design mocks.

## Alternatives and consequences

A browser-only list of previously created users would omit existing accounts and
cannot satisfy the directory/assignment screen. Widening a company user endpoint
to include platform Sales users would confuse tenant ownership. A separate bounded
projection of the already-managed Sales population preserves that distinction.
There is no new permission, dependency, migration or provider selection change.
The UI's first-login, lifecycle, eligibility and retry decisions remain enforced
by the existing server producers. Production deployment is separate work.

## Verification

Test actual JSON/PostgreSQL and authenticated web/API paths, projections, roles,
stale versions/authority, explicit PUT and one retry command. Check browser
keyboard, responsive and error/empty states. The self-check is not independent
approval; retain Review until owner review/merge.
