# Mock ERP synthetic invoices (B2B-067)

The trusted development/test Mock supports an explicit completed invoice fixture.
Submit a valid order with `X-Mock-ERP-Scenario: completed` to the existing
`POST /mock-erp/v1/orders` endpoint. Default/success submissions remain ordinary
created orders without invoices. This control marks a synthetic completed case;
it does not perform warehouse fulfillment or change a portal business status.
The order response still uses `status: created` for its process-local ledger entry.

Read `GET /mock-erp/v1/orders/:erpOrderId/invoice`. Known completed fixtures return
HTTP 200 with the following shape (IDs shown as examples):

```json
{
  "invoice": {
    "erpInvoiceReference": "MOCK-INV-12345678-1234-4234-8234-123456789abc",
    "erpOrderId": "12345678-1234-4234-8234-123456789abc",
    "portalOrderId": "12345678-1234-4234-8234-123456789def",
    "customerId": "DEMO-C001",
    "invoiceNumber": "DEMO-12345678-1234-4234-8234-123456789abc",
    "status": "available",
    "amount": "100.00",
    "currency": "AED",
    "issuedAt": "2026-10-31T12:00:00.000Z",
    "documentReference": "mock-invoice:12345678-1234-4234-8234-123456789abc"
  }
}
```

Amount is a fixed synthetic demo value, independent of order quantities/prices.
No tax, credit, total or financial rules are implemented. IDs/number/reference are
stable functions of the retained ERP order UUID; issuedAt is its captured creation
time. The opaque documentReference is neither an external URL nor an implemented
PDF/download. Portal invoice sync, tenant authorization and safe document delivery
belong to B2B-068/B2B-069. ERP owns this metadata; the portal must not calculate it.

Known ordinary orders return `{ "invoice": null }`. Malformed UUIDs return 400
`INVALID_ORDER_ID`; unknown IDs (including after restart) return 404
`ORDER_NOT_FOUND`, using fixed redacted errors. Responses use no-store and add no
CORS. This is the existing unauthenticated trusted Mock surface, not a public
customer API; frontend calls must go through a tenant-authorized Portal API.

The initial scenario is retained: ordinary orders cannot acquire an invoice by
replaying with completed, and completed orders keep the same invoice when replayed
with success/failure scenarios. Existing idempotency/conflict/failure validation
rules still apply. Invoices share the 1000-order process-local ledger lifetime;
reads/replays do not allocate additional invoices. Restart clears orders/invoices,
with no persistence or distributed guarantee. No autonomous completion or timers.

Run `npm test --workspace=@b2b-portal/mock-erp` and root `npm run check`.
Coverage includes exact metadata, detached records, normal/completed/missing cases,
concurrent replay, failure recovery, unchanged scenario semantics and app restart.
