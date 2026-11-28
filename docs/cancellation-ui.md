# Cancellation UI (#78)

Customers open /orders/cancellations through the link on the draft-order screen,
choose an order from their company and read its latest cancellation state.
Requested means a decision is pending and the request has not cancelled the order;
Approved and Rejected are shown only from canonical API results. Terminal orders
cannot start another request. Sales workspace composition remains #75.

An accessible native dialog follows the supplied design, labels a required
1–500-character reason, and provides Keep order, Close, Escape and normal focus
restoration. Validation focuses the reason. One explicit submission carries a
stable Idempotency-Key through the authenticated client. A failure may represent a
saved request; the UI requires status checking rather than blindly retrying.
Pending or approved requests suppress another submission. No reason/key persists
to browser storage; no provider error or technical payload is displayed.

GET /api/v1/companies/:companyId/orders/:orderId/cancellations returns
{cancellation: null | {requestId, orderId, status}} with standard no-store/auth
envelopes. It uses the existing cancellation permission, current account/company/
assignment checks and draft ownership. Unknown selectors refuse. Reasons and
provider payloads are not selected. JSON now uses the recoverable boundary in
[json-cancellation-recovery.md](json-cancellation-recovery.md); the same UI requires
status checking after uncertainty and never automatically repeats a cancellation.
See ADR-029 and cancellation-api.md for the shared contract and provider limits.
