# ADR-029: Cancellation UI and private status projection

- Status: Proposed — implementation review pending
- Related issue: #78 / B2B-066

The cancellation producer #76 exposes requested/approved/rejected POST results
but has no read operation for checking a later decision or recovering the UI
after an uncertain response. Add a read-only GET at the existing cancellation
collection path. It returns only the latest request ID, order ID and finite state,
or null. Never select a reason, provider payload, actor or ERP reference.

Reuse the existing orders.cancel permission and current company-profile authority
checks before and after the scoped read. Customer roles stay in their own active
company; current Sales assignment remains required. Another user's draft cannot
be inspected through this path. PostgreSQL reads one company/order-scoped latest
projection; JSON remains unavailable with #195 and is not silently enabled.
Reads are bounded by the existing pool/statement limits and four in-flight reads.

The customer UI extends existing feature folders, shared primitives, native
dialog and design tokens. A small order selector preserves the current draft
screen and keeps full history/timeline and Sales workspace composition separate.
Canonical statuses render fixed Requested, Approved and Rejected messages; no
optimistic cancellation or notification promise. The modal requires a bounded
reason, retains one request key for an uncertain attempt, and guards repeated
writes until the latest state has been read. It never retries a write itself.
The session client admits only a validated idempotency header, not arbitrary
Authorization/header overrides. Reasons and keys stay in component memory.

No migration, new cancellation state, ERP call, mutation authority or recovery
mechanism is added. Read projection and UI changes are reversible. Test current
authority, tenant/draft privacy, all three outcomes, failure/reload, key forwarding,
late responses and keyboard/focus behavior. Human review remains pending.
