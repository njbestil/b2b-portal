# Authorization regression suite

Issue [B2B-084 / #96](https://github.com/njbestil/b2b-portal/issues/96) requires rejection of cross-company and unassigned Sales Staff access. Run the suite from the repository root:

```powershell
npm ci
$env:B2B_TEST_MIGRATIONS_DATABASE_URL = 'postgresql://postgres@127.0.0.1:35496/postgres'
$env:B2B_TEST_DATABASE_URL = $env:B2B_TEST_MIGRATIONS_DATABASE_URL
$env:B2B_TEST_MIGRATIONS_CLI_DATABASE_URL = $env:B2B_TEST_MIGRATIONS_DATABASE_URL
npm run test:authorization
npm run check
```

The URLs must point to a **disposable test PostgreSQL database**. Tests create/drop randomly named schemas, run actual migrations and insert synthetic principals, sessions and business records. The full check also uses the other two URLs for database adapter and migration CLI tests; the CLI connection requires permission to create disposable databases. Never use an operational database. JSON tests create temporary stores and remove them at teardown. HTTP servers bind ephemeral loopback ports and close after each test. The database server itself is managed by the caller.

Without the URL, PostgreSQL cases explicitly skip: a passing JSON-only run is incomplete provider evidence. The standard `npm test`/`npm run check` also discovers the new regression file. The focused command runs existing feature tests as well as the composed-app regression; it adds no dependencies and does not replace the broader checks.

## Acceptance and coverage

| Boundary                                                                                                                                               | Durable tests included in the command                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Backend role admission, spoofed client roles, restricted/revoked/inactive actors                                                                       | `authorization.test.mjs`                                   |
| Both customer roles, foreign company/object/parent selectors, list totals and pagination, eligible catalog/prices, response allowlists                 | `tenant-isolation.test.mjs`                                |
| Assignment authority, ended/future/unassigned Sales, current grants, proof expiry and actual provider waits                                            | `sales-assignments.test.mjs`, `sales-companies.test.mjs`   |
| Assigned Sales profile/address reads and customer-owned mutations, immutable ERP fields, stale/current actor checks                                    | `company-profiles.test.mjs`, `delivery-addresses.test.mjs` |
| Customer administrator provisioning/status boundaries and company lifecycle                                                                            | `customer-users.test.mjs`, `account-status.test.mjs`       |
| Customer-owned draft/item commands, foreign draft IDs and role restrictions                                                                            | `order-drafts.test.mjs`, `order-items.test.mjs`            |
| Customer-only invoice list/count/detail, foreign/missing equivalence and private ERP/document references                                               | `invoices.test.mjs`                                        |
| One unchanged token across multiple real routers after membership/role, restriction, lifecycle, credentials, expiry, revocation and assignment changes | `authorization-regression.test.mjs`                        |

The composed-app tests use the existing authentication fixture: real password verification, signed access tokens and persisted sessions. Business services use real JSON/PostgreSQL adapters, including invoice writes through their checked persistence contract. No principal, authorization decision or HTTP response is mocked. Each provider has three regression scenarios:

1. Move a customer administrator from company A to B without logging in again. Profile/address identity, invoice list/count/detail and tenant order/user reads follow current membership. Old-company routes and foreign invoices deny, forged headers do not elevate, query scope injection rejects, and demotion immediately removes directory access.
2. Exercise a previously working token on profile, addresses, invoice list/detail and tenant company/orders/users/catalog. Password-change restriction denies with 403; inactive user/company, changed credential binding, token expiry and session revocation deny with 401. Positive controls before/after reversible changes prevent unavailable services from masquerading as authorization success.
3. Reassign Sales from A to B using the same token. Assignment list totals and profile/address reads change together. Ended and future grants produce empty lists and reject object reads; old-company access rejects after reassignment. Assignment does not grant the customer-only invoice or tenant-order API.

All regression responses use `no-store`. Denied responses contain an error and no data; foreign/missing invoice errors match. Collected responses and request logs are checked for access/refresh tokens, credential hashes, binding fields, private invoice references, document locators and private SQL snapshot data. Granular feature tests remain the detailed payload/allowlist and failure coverage; their assertions are not copied into a second feature matrix.

## Limits

This is local regression evidence for the merged APIs and their provider implementations, not independent security approval or production verification. It does not implement or certify unmerged admin APIs, assisted-order confirmation/cancellation, global security middleware, frontend end-to-end journeys or deployment configuration. Session/password lifecycle has additional coverage in its own tests, run by `npm run check`. New routes must add their own positive and authorization-negative cases when implemented.
