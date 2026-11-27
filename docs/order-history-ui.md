# Company order history UI (#60 / B2B-048)

`/orders/history` is linked from the unchanged draft/cart screen. It uses the
existing customer-only company history API for combined search/status/UTC dates,
20-item server paging, list selection, immutable detail and explicit refresh.
The supplied ZIP's list/detail, badges, delivery, item table and status layout
are adapted to existing feature folders, shared primitives and CSS tokens.

The timeline shows recorded creation/submission dates and the current business
state. Missing transition dates and delivery estimates are explicitly unavailable;
it never invents confirmed/delivered timestamps, monetary totals, VAT, payment
terms or past events. Legacy records without snapshots remain clearly incomplete.
Snapshot strings are displayed exactly without floating-point currency rounding
or live catalog joins. Private identifiers, notes and technical errors are dropped.

Reorder is an explicit request to the existing backend and opens its canonical
new draft. It does not auto-retry or optimistically announce a saved order. After
an uncertain result the screen directs the user to check drafts before another
reorder. Cancellation uses the existing cancellation screen. Confirmation and
future status-event producers are unchanged. No backend/dependency/schema change.

Native labelled filters, semantic tables/lists/time elements, persistent status
regions, focused validation errors and shared route heading focus are retained.
Requests cancel on identity/navigation changes and late results cannot publish
into another record. Preview, internal/Sales and first-login accounts cannot fetch
customer history. Unit/SSR and real JSON/PostgreSQL API tests cover the contract,
privacy, filtered counts, immutable detail and malformed/unavailable data.
