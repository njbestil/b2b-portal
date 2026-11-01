# Mock ERP fulfillment fixtures and retrieval

Child #134 supplies only the Mock producer for #66. The Portal API owns protected
retrieval, correlation validation and mapping to its Confirmed/Fulfilling/Delivered
business states. This child does not complete or close parent #66.

Initial `POST /mock-erp/v1/orders` can include the exact trusted test header
`X-Mock-ERP-Fulfillment-Scenario: confirmed|fulfilling|delivered`. Omitted means
confirmed (ERP acceptance fixture). The existing body, status `created`, order
identity and ordinary success/failure behavior remain unchanged. This is an
explicit immutable synthetic facet, not elapsed-time warehouse progression.

Read `GET /mock-erp/v1/orders/:erpOrderId/fulfillment`:

```json
{
  "erpOrderId": "12345678-1234-4234-8234-123456789abc",
  "portalOrderId": "12345678-1234-4234-8234-123456789def",
  "customerId": "DEMO-C001",
  "fulfillmentStatus": "fulfilling",
  "updatedAt": "2026-11-01T00:00:00.000Z"
}
```

Correlation and time come from the retained order. Only the three lowercase
states are supported. The first accepted publication captures its state; same-key
replay and concurrent reads never progress/regress or regenerate it. New creation
headers do not change a retained order, invoice or state. The original order
`created` field is not the fulfillment field and must not be interpreted as
Delivered. Queries/HEAD are read-only and return detached snapshots.

The prior `completed` invoice fixture is independent: invoice availability never
infers fulfillment. Tests may explicitly combine an invoice with a selected state.
Cancellation decisions are also synthetic facets and do not overwrite this
fixture. Real business/cancellation terminal guards belong to the Portal API;
this Mock does not authorize transitions or calculate financial data.

For status GET only, the existing `X-Mock-ERP-Scenario` header can select success
(default), unavailable (503 ERP_UNAVAILABLE), or timeout (1500 ms then 504
ERP_TIMEOUT). Client disconnect cancels a timeout. These reads publish no state;
recovery returns the original snapshot. Other values return fixed 400
INVALID_FULFILLMENT_SCENARIO. Known malformed target IDs return 400
INVALID_ORDER_ID; unknown targets return 404 ORDER_NOT_FOUND, including after
restart. Creation also rejects malformed/unknown fulfillment controls before
publication. Existing order failures do not reserve any fixture before recovery.

All responses use no-store and add no CORS/session. Existing fixed redacted Mock
error bodies apply. This is the trusted backend-facing development/test service,
not a customer/tenant-authorized Portal endpoint; frontend must use the authorized
Portal API. A must validate exact order/customer correlation and apply permission
and business-state guards before using these fixtures.

State shares the bounded 1000-order application lifetime, with no eviction.
Reading never allocates an order/state/invoice; retained replay works at capacity.
Restart clears it; no shared/distributed/durable state, background worker or real
ERP poller is introduced. No database, dependency, deployment or portal code change.

Run the focused Mock suite and root `npm run check`. Coverage includes each state,
exact correlation, detached and repeated/concurrent reads, mixed first-publication
and replay, capacity/restart, unknown/malformed targets/controls, technical
unavailability/timeout/cancellation/recovery, and unchanged order/invoice/cancellation
semantics. These checks establish the child producer, not full #66 integration.
