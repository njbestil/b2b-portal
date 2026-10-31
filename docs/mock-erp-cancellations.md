# Mock ERP cancellation decisions (B2B-065)

This is the independently implemented Mock component of #77. The declared #76
portal cancellation workflow dependency remains open; real permissions, gateway
integration and business transitions are not delivered by this fixture.

POST `/mock-erp/v1/orders/:erpOrderId/cancellations` for an order retained by the
same Mock application. A Mock accepted order is the ERP identity the backend will
retain after confirmation. The existing order response stays `status: created`;
this endpoint does not change portal or warehouse status.

Send uncompressed JSON (at most 4 KiB) and an `Idempotency-Key` with the existing
1–128 character ASCII letter/digit then letter/digit/dot/underscore/colon/hyphen
format. The exact request body is:

```json
{
  "portalCancellationRequestId": "12345678-1234-4234-8234-123456789abc",
  "reason": "Customer changed the delivery plan"
}
```

The backend request UUID is case-normalized; reason is required, trimmed, nonblank,
up to 500 UTF-16 code units, without control characters or unpaired surrogates.
Unknown fields, role/company/actor overrides and client decision fields fail.
Known ERP order/customer/portal order correlations are read from the Mock ledger.

Use the trusted test header `X-Mock-ERP-Cancellation-Scenario`:

| Value                 | Result before any decision is retained                                 |
| --------------------- | ---------------------------------------------------------------------- |
| omitted or `approved` | synthetic approved decision                                            |
| `rejected`            | synthetic rejected decision with a fixed explanation                   |
| `timeout`             | 1500 ms bounded wait then 504 ERP_TIMEOUT; disconnect cancels the wait |
| `unavailable`         | 503 ERP_UNAVAILABLE                                                    |

These are explicitly selected fixtures, not financial/stock/fulfillment eligibility
rules. Distinct request IDs represent independent synthetic decisions. The Portal
API owns whether a new request is permitted, actor/company/assignment authorization,
required reason collection, business progression and cancellation/integration races.
It must validate response correlation before applying an outcome. Rejection is a
business outcome, not automatic technical retry. No invoice reversal or new price
rule is implemented.

A new decision returns 201; a retained replay returns 200 with the original body:

```json
{
  "portalCancellationRequestId": "12345678-1234-4234-8234-123456789abc",
  "reason": "Customer changed the delivery plan",
  "erpCancellationId": "12345678-1234-4234-8234-123456789def",
  "erpOrderId": "12345678-1234-4234-8234-123456789aaa",
  "portalOrderId": "12345678-1234-4234-8234-123456789bbb",
  "customerId": "DEMO-C001",
  "outcome": "approved",
  "decidedAt": "2026-10-31T12:00:00.000Z",
  "rejectionReason": null
}
```

For rejected decisions, outcome is `rejected` and rejectionReason is
`Simulated ERP cancellation rejection.`. Returned records are detached.

Retained identity includes the key, canonical target ERP order, portal request
UUID and normalized reason. Reordering JSON keys, UUID case and reason outer
whitespace does not change identity. A later known scenario cannot change a
retained result. A retained key with different content/target returns 409
IDEMPOTENCY_CONFLICT. Another key for the retained portal request UUID returns 409
CANCELLATION_ALREADY_EXISTS, including across orders. Failures before publication
reserve no key/request; recovery is an explicit successful retry of the same body.
There is no automatic retry or eviction.

Invalid requests/keys/scenarios use 400, malformed target UUID uses 400
INVALID_ORDER_ID, unknown target uses 404 ORDER_NOT_FOUND, invalid media/encoding
415, oversized body 413, and capacity 503 CANCELLATION_CAPACITY_REACHED. Errors use
the existing fixed redacted `{error:{code,message}}` Mock shape. All responses are
no-store, with no CORS/session/cookie. This is only the existing trusted
backend-facing development/test Mock; never call it directly from the frontend or
present it as a protected customer cancellation API.

At most 1000 cancellation decisions are held per app, separate from the existing
1000-order limit. Existing replay still works at capacity. Orders, invoices and
accepted decision records are unchanged by other decisions. All state is lost on
restart and instances do not coordinate; no distributed/durable guarantee exists.

Run `npm test --workspace=@b2b-portal/mock-erp` then root `npm run check`.
The tests cover both outcomes, required input, detached correlation, concurrency,
conflicts, bounded capacity, technical failures/cancelled timeout/recovery,
restart/isolation, safe HTTP errors and existing order/invoice/scenario behavior.
Integrated #76/#77 acceptance/Done remains gated on the real portal consumer,
authentication/permissions and required reviews.
