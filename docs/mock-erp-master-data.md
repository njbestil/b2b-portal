# Mock ERP master data (B2B-032)

The standalone Mock ERP includes deterministic, synthetic commercial data. Copy
`.env.example` to `.env` if not already configured. Build with
`npm run build --workspace=@b2b-portal/mock-erp`, then start with
`npm start --workspace=@b2b-portal/mock-erp`. Existing host/port configuration is
unchanged (`127.0.0.1:3001` in `.env.example`); `NODE_ENV`, `MOCK_ERP_HOST` and
`MOCK_ERP_PORT` remain required. No database, credentials or new environment
variables are needed.

`GET /mock-erp/v1/master-data` returns HTTP 200 JSON with `Cache-Control: no-store`.
Its six top-level arrays are `customers`, `products`, `pricing`, `eligibility`,
`inventory` and `credit`. Every request produces a fresh complete seed, so process
restarts and client-side edits cannot alter subsequent responses. No mutation or
reset endpoint is provided. Root and health responses remain unchanged.

## Fixture contract

Identifiers are stable synthetic ERP keys, not portal company/product UUIDs.
All monetary values and quantities are decimal strings. Prices, MOQ and available
inventory use the product's selling UOM. `packSize` describes base equivalence;
`null` means not applicable. Prices use AED and a fixed UTC `effectiveFrom` with
`effectiveTo: null` (no expiry). A price with `customerId: null` is the default B2B
price; a customer-specific row represents an override. The endpoint returns raw
fixtures, not a resolved customer catalog or an order-eligibility decision.

| Fixture                         | Purpose                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `DEMO-C001` / Harbour Kitchen   | NET30, clear credit; rice override AED 27.50 versus default AED 30.00 |
| `DEMO-C002` / Orchard Cafe      | NET15, credit hold; rice default; milk explicitly ineligible          |
| `DEMO-P001` / Rice Bag          | Five-KG bag; available stock                                          |
| `DEMO-P002` / Milk Carton       | Twelve one-litre units; MOQ two cartons; zero stock                   |
| `DEMO-P003` / Apples KG         | Fractional MOQ 0.5 KG and stock 25.5 KG                               |
| `DEMO-P004` / Retired Loaf      | Inactive despite a price, stock and eligibility                       |
| `DEMO-P005` / Unpriced Biscuits | Active and eligible but deliberately has no price                     |

Eligibility contains one explicit boolean per customer/product pair; inventory
contains one row per product and credit one row per customer. Credit includes
status, currency, limit and outstanding balance. These are isolated test fixtures,
not real customer information or a production financial decision service.

## Boundaries and verification

Use only in a trusted development/test environment. This unauthenticated Mock
snapshot includes all synthetic customer prices and credit, not tenant-filtered
portal output. Do not expose it publicly, load real commercial/customer data into
it, or call it directly from the frontend. CORS is not enabled and is not an
authentication mechanism. ERP remains the commercial source of truth.

The Portal API's current `ErpGateway` still supports health only; no business method
or portal persistence is added here. [Mock order creation](mock-erp-orders.md) is
implemented separately by B2B-049. Catalog synchronization (B2B-034), portal order
submission (B2B-050), scenario controls and demo portal seed/reset remain separate.

Run `npm test --workspace=@b2b-portal/mock-erp` for fixture/reference integrity,
boundary scenarios, detached snapshots and real HTTP read-only behavior. Root
`npm run check` also covers actual startup in fresh processes both with an env file
and with environment overrides, including identical seeded responses.
