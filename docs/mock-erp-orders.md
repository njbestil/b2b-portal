# Mock ERP order submission (B2B-049)

The standalone Mock ERP creates synthetic orders at `POST /mock-erp/v1/orders`.
Use the existing [Mock ERP setup](mock-erp-master-data.md); there are no new
dependencies, configuration variables or database requirements. Root, health and
master-data endpoints are unchanged.

## Request and response

Send `Content-Type: application/json` and an `Idempotency-Key` header. Keys are
case-sensitive, 1–128 ASCII characters, start with a letter/digit and may then
contain letters, digits, `.`, `_`, `:` or `-`. Do not use secrets as keys.

```json
{
  "portalOrderId": "12345678-1234-1234-1234-123456789abc",
  "customerId": "DEMO-C001",
  "items": [{ "productId": "DEMO-P001", "quantity": "2" }]
}
```

`portalOrderId` is a UUID; `customerId` and `productId` refer to active seeded
Mock ERP records, not portal company/product IDs. Provide 1–100 lines with no
duplicate products. Quantities are positive decimal **strings** in selling UOM,
with at most 12 integer and 6 fractional digits. Numbers, exponents, leading
zeroes (except `0.x`), whitespace and unknown fields are rejected. JSON bodies
are limited to 32 KiB and compressed bodies are not accepted.

The first successful request returns HTTP 201 and this provider-specific wire
shape (generated values shown as examples):

```json
{
  "portalOrderId": "12345678-1234-1234-1234-123456789abc",
  "customerId": "DEMO-C001",
  "items": [{ "productId": "DEMO-P001", "quantity": "2" }],
  "erpOrderId": "12345678-1234-4234-8234-123456789def",
  "createdAt": "2026-10-29T00:00:00.000Z",
  "status": "created"
}
```

`created` describes a Mock ERP record, not a portal business/integration status
transition. This foundation validates shape and active references only. It does
not calculate prices/totals, enforce eligibility, MOQ, stock or credit, decrement
inventory, or implement delivery/fulfillment. Portal validation and Mock business
rejection scenarios remain their own issues; a successful call is not evidence
that those commercial rules passed.

## Idempotency and lifetime

- The same key and normalized request return HTTP 200 with the **original**
  order ID, timestamp and complete body, including after concurrent submissions.
- UUID case, JSON property order, line order and trailing decimal zeroes do not
  change request identity. Decimal normalization never uses floating point.
- A retained key with a different valid normalized request returns HTTP 409
  `IDEMPOTENCY_CONFLICT`. A new key for an already-created portal order UUID
  returns HTTP 409 `ORDER_ALREADY_EXISTS`. Neither replaces the original record.
- Invalid requests do not reserve keys or portal order references.
- Each application instance keeps up to 1000 orders and their idempotency
  records. At capacity, new work returns HTTP 503 `ORDER_CAPACITY_REACHED`, while
  existing replays still work. Records are not expired or evicted.
- Orders and keys live **only in this single process/app instance**. Restarting
  clears them; separate instances do not coordinate. This is demo state, not
  durable/exactly-once distributed persistence. Do not scale replicas or assume
  restart-safe replay. There is no public reset/list/detail endpoint.

Errors return `{ "error": { "code": "...", "message": "..." } }` with fixed,
redacted messages. Malformed JSON/invalid orders or keys use 400, oversized bodies
413, unsupported content type/encoding 415, conflicts 409 and unexpected failures 500. Order responses, including errors, use `Cache-Control: no-store`.

## Boundaries and verification

This remains an unauthenticated, trusted development/test Mock with synthetic
data, not a public or tenant-authorized portal endpoint. No CORS access is added.
The frontend must not call it directly. The Portal API's `ErpGateway` is still
health-only: B2B-050 owns portal submission/integration transactions; B2B-052 owns
automatic retry. B2B-053 adds the synthetic scenarios below.
No portal storage, schema, authorization, order workflow or deployment changes.

Run `npm test --workspace=@b2b-portal/mock-erp` for creation, exact normalization,
sequential/concurrent replay and conflicts, request/response isolation, capacity
without eviction, parser limits and redaction. Root `npm run check` also verifies
creation/replay through actual entry-point processes in both environment modes.

## Reproducible failure scenarios (B2B-053)

On the same order endpoint, optionally send `X-Mock-ERP-Scenario` with one exact
allowlisted value. Missing or `success` retains normal behavior. Unknown, blank,
duplicate/comma-joined or differently cased values return 400 `INVALID_SCENARIO`.
This control exists only on the already trusted development/test Mock, not the
Portal API. It never changes master data or implements real commercial rules.

| Value                | Outcome                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `timeout`            | Wait 1500 ms, then 504 `ERP_TIMEOUT`; a client with a shorter deadline observes a timeout |
| `unavailable`        | 503 `ERP_UNAVAILABLE`                                                                     |
| `validation`         | 422 `ERP_VALIDATION_FAILED`                                                               |
| `credit-hold`        | 422 `CREDIT_HOLD`                                                                         |
| `insufficient-stock` | 409 `INSUFFICIENT_STOCK`                                                                  |

For example, POST the request above with `Idempotency-Key: demo-recovery` and
`X-Mock-ERP-Scenario: unavailable`; repeat to reproduce 503. Remove the scenario
header and retry the **same key/body** for a single 201. Repeating success gives
200 with the original order. Change a valid body with the retained key for 409
`IDEMPOTENCY_CONFLICT`, or use a new key for the same portal order UUID for 409
`ORDER_ALREADY_EXISTS`. Restarting the Mock clears all process-local demo state.

Body/key validation and retained replay/conflicts run before injecting a known
failure. An already successful order still replays even if a failure scenario is
selected later. Failures before publication do not reserve a key/order reference;
recovery is an explicit switch back to success, not an automatic retry policy or
per-key hidden failure counter. The finite timeout timer is cancelled on client
disconnect; it never creates a delayed order after the caller has timed out.
Health remains up during order-only downtime simulation. No failure scenario
changes portal business/integration status or starts a portal retry worker.

`scenarios.test.mjs` verifies all outcomes, validation/redaction, bounded timeout
and cancellation, concurrent recovery, retained replay and actual-process startup.

B2B-067 adds an explicit [synthetic completed invoice fixture](mock-erp-invoices.md).
Ordinary success remains unchanged; invoice availability never implies an automatic
portal fulfillment transition.

B2B-065 adds [synthetic cancellation decisions](mock-erp-cancellations.md) for retained orders; portal authorization and business cancellation remain separate.
