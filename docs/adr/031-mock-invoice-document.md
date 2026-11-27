# ADR 031: Authenticated mock invoice document retrieval

Status: Proposed

## Context

B2B-069 requires customer invoice list/detail and a mock document download. Existing
invoice records retain opaque references; the Mock ERP supplies bounded synthetic
text. The browser must not receive a provider URL or bypass company/session checks.

## Decision

Use a separate read-only document service and route. Resolve the company invoice
and order link before fetching a server-derived path from the configured Mock
origin. Bound and correlate the response exactly. Recheck live authorization and
stored linkage before returning a safe Portal-named attachment. Enable only the
explicit non-production Mock source. Keep current financial metadata unchanged.

## Consequences

Downloads can fail after an account/link change or Mock restart; show unavailable
rather than synthesize a financial document or silently synchronize metadata.
The text includes its own correlated synthetic ERP references. A production source
and financial/PDF requirements need a separately reviewed contract and issue.
No new dependency, migration, permission or accounting behavior is introduced.
