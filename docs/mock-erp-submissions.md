# Synthetic submission receipts (#145; consumer #62)

POST /mock-erp/v1/submissions is an additive trusted Mock/test surface. It does
not change the legacy /orders endpoint or public portal routes. #62 owns mapping
and portal validation/integration transactions; this endpoint has no real ERP
fallback. There are no monetary calculations, inventory decrements or portal
mutations. Do not expose Mock headers to browser/customer APIs.

Send application/json (32 KiB maximum, no compression), with exactly:

- externalRequestReference: case-sensitive 1–128 ASCII reference, same grammar as
  the legacy Idempotency-Key. It is the external request identity, in the body.
- portalOrderId: UUID (case normalized).
- customerId: active seeded Mock customer.
- items: 1–100 unique active seeded product references; each contains productId,
  quantity, sellingUom, unitPrice, currency, snapshot.
- quantity: positive decimal string, up to 12 integer and 6 fraction digits.
  unitPrice: nonnegative decimal string with the same bounds. No float conversion,
  rounding or commercial validation occurs. Trailing zeroes are preserved.
- sellingUom: Piece/Pack/Carton/Case/Bag/KG. currency: three uppercase letters.
  snapshot: exactly sku (1–128 chars), name (1–256 chars), bounded nonempty
  trimmed text without ASCII control characters. Snapshot text is retained,
  not replaced by current master data. No unknown fields are accepted.

All receipts contain externalRequestReference, portalOrderId and customerId:

- accepted: HTTP 201 initially, outcome accepted, order with original erpOrderId,
  createdAt, status created, correlation and exact submitted items/snapshots.
- rejected: HTTP 200, outcome rejected, rejection {code,message}; no order
  is created. This is a terminal business result, not transport success implying
  order acceptance. Consumers must inspect outcome.
- existing-order: HTTP 200, outcome existing-order, original order; a new external
  reference for identical portal order/customer/items never allocates another order.
- Same external reference/body always replays the original receipt as HTTP 200,
  including rejections after a scenario change. Different valid body with that
  reference: 409 IDEMPOTENCY_CONFLICT. A different body/reference for an already
  accepted portal order: 409 ORDER_ALREADY_EXISTS. Line order and exact decimal
  spellings participate in identity; object property order does not.
- Parser/shape failures use the existing safe {error:{code,message}} envelope,
  including 400 INVALID_SUBMISSION; they reserve nothing.

X-Mock-ERP-Scenario is missing/success, validation (ERP_VALIDATION_FAILED),
credit-hold (CREDIT_HOLD), insufficient-stock (INSUFFICIENT_STOCK), or invalid-item
(INVALID_ITEM). These are explicit synthetic rejection fixtures, not commercial
validation. Unknown/blank/duplicate controls return 400 INVALID_SCENARIO.
A terminal receipt cannot be changed by a new scenario. A corrected business
submission needs a new external reference. Technical failure scenarios are #146.

One immutable receipt ledger per application, maximum 1000 references including
rejections and existing-order receipts; 503 SUBMISSION_CAPACITY_REACHED never
evicts retained replay. Accepted orders use the existing bounded order service
and share its invoice/fulfillment/cancellation lookup. No await occurs between
inspection/publication. Responses detach nested state, and have no-store headers.
Restart loses all demo state; multiple instances do not coordinate. This is not
production durable idempotency. No auth, scheduler, retry engine or portal
business transition is implemented. Consumer #62 must explicitly choose/adapt
this producer contract; legacy /orders remains independently compatible.
