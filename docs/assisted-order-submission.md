# Confirmed assisted-order submission (#74)

The customer first records the immutable decision using the existing confirmation
endpoint. The actual customer who confirmed then reviews current prices and
explicitly accepts them to submit. Sales cannot approve or submit on their behalf.
A same-company Customer Admin may confirm in place of the designated contact;
the real deciding customer remains the snapshot's submitted-by actor. The original
Sales creator and confirmation remain unchanged.

`POST /api/v1/orders/:id/submission-quote` accepts exactly `{confirmationId}`.
It requires a normal customer session, a matching CONFIRMED record decided by that
actor, and an active Sales creator still assigned to this company. It evaluates
the existing submission checks against current Mock catalog data. It returns a
token, currency, total, delivery and item prices. The preview runs the same
transaction preparation and rolls back before publishing any reservation,
snapshot, audit or outbound request. It makes no ERP submission call.

`POST /api/v1/order-drafts/:id/submit` now additionally accepts exactly
`{confirmationId, quoteToken}` with the existing required `Idempotency-Key`
header. For assisted orders the backend derives a stable reservation key from
the confirmation ID, so different browser/header keys cannot create another
submission identity. The canonical request retains the accepted token. The
initial transition revalidates customer/session/company, confirmation, current
Sales assignment, address, product access, MOQ/UOM, stock, minimum and prices.
The acceptance screen displays delivery and contact details from that same fresh
quote. Address/contact changes also invalidate its token before publication.
Changed quote content returns 409 before publication. Refresh and explicitly
accept a new quote; never silently substitute prices. This replaces the direct
draft's prior price acknowledgement only for the immutable assisted-order path.

The existing submission transaction commits SUBMITTED, immutable financial and
delivery snapshots, one `order.submitted` audit record, the reservation and one
integration transaction together. The existing dispatcher and configured retry
gateway run after commit. A 202 means the submission was recorded, not that ERP
accepted it. Business rejection and unknown outcomes retain their existing
non-retry behavior; only correlated no-effect technical failures use the existing
bounded policy. Replays reuse the reservation, recheck current authority and
never repeat a claimed attempt. After an uncertain response, refresh confirmation
and company order history before another action. Confirmed records remain readable
after submission, with business status separate from the customer decision.
History and reorder accept a different creator/submitter only when the provider
verifies the retained CONFIRMED customer approval for that Sales-created order.
The approval ID remains private and does not relax company scope or allow a
snapshot with a mismatched deciding customer.

No SQL migration, new dependency, separate Sales ERP path or production provider
is added. JSON and production submission remain unavailable under their existing
durability/provider restrictions. The quote is a bounded read from Mock before
database locks, not a reservation of ERP stock or prices.

Acceptance evidence: `assisted-submission.test.mjs` exercises real PostgreSQL,
Mock submission, quote rollback, actual approver/tenant/role checks, concurrent
keys, stale prices, assignment removal, atomic audit failure and retained ERP
outcomes. Existing confirmation, direct submission, snapshot and retry tests
remain regression gates. UI checks cover quote parsing and explicit acceptance.
