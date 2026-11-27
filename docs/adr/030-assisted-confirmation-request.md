# ADR-030: Assisted confirmation request publication

- Status: Proposed — implementation review pending
- Related issue: #72 / B2B-060

Keep the frozen order_confirmations logical model and the existing Sales scope.
Requesting confirmation holds company, credential, session, assignment and order
authority through publication; it does not approve or submit an order.

SQL atomically inserts the confirmation and changes order state. An additive
request fingerprint binds actor/company/order/version/contact/key for stable
replay without retaining raw keys. JSON embeds that logical record with its order
in one atomic file publication, avoiding a new multi-file recovery journal.
Keeping a second JSON file would require a wider recovery boundary and new intent
handling across every writer. The existing single-process coordinator remains
mandatory; external writers are offline.

Existing JSON parsers/writers recognize and preserve the bounded private record;
unknown fields fail closed. Customer projections stay whitelisted. Historical SQL
records without fingerprints are readable only under future decision contracts,
not guessed/replayed. No rollback of committed requests after audit uncertainty,
automatic retry, notification, customer decision or ERP call is introduced.

Verify SQL rollback, atomic JSON publication/interruption, replay/version races,
current authority, contact scope and existing writer/privacy compatibility. The
additive migration requires normal explicit deployment review and application.
