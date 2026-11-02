# Company-scoped reads

This layer consumes #32's backend actor and the existing PostgreSQL/JSON read
ports. A role permission is checked again in every service. Customer company scope
is derived from the current validated actor, then compared with the URL company
before a business repository call. A UUID, client company field, query selector or
Sales role is not ownership proof.

## Endpoint / service / repository ownership matrix

All paths are under `/api/v1/companies/:companyId`, require normal authenticated
Bearer admission and return the standard no-store envelope.

| GET path            | Service      | Permission          | Repository scope         | data          |
| ------------------- | ------------ | ------------------- | ------------------------ | ------------- |
| base path           | getCompany   | company.read        | companies.findById       | {company}     |
| /users              | listUsers    | customer-users.read | users.listCustomers      | {items,total} |
| /users/:userId      | getUser      | customer-users.read | users.findCustomerById   | {user}        |
| /catalog            | listProducts | catalog.read        | catalog.listEligible     | {items,total} |
| /catalog/:productId | getProduct   | catalog.read        | catalog.findEligibleById | {product}     |
| /orders             | listOrders   | orders.read         | orders.list              | {items,total} |
| /orders/:orderId    | getOrder     | orders.read         | orders.findById          | {order}       |

Customer Admin/Customer User can read only their current own company; Customer
User has no directory permission. Internal Admin can select any existing company
and retain historical visibility for suspended companies. Sales Staff remains
403 until #34 adds active assignment enforcement. No caller-controlled assignment
callback or header bypass is installed here. This is deliberately fail-closed,
not a claim that assigned Sales access is already integrated.

Only list routes accept `offset` (default 0) and `limit` (default 20, maximum
100); values are canonical nonnegative integers, with a positive limit. Unknown,
duplicate or malformed query values are 400 INVALID_COMPANY_QUERY. Detail/profile
routes accept no query selectors. UUIDs normalize to lower case. Invalid UUID
syntax is 400 and never an authorization grant.

For operations the role permits, another company's path, a foreign object within
an own-company path, and a missing object all return generic 404
RESOURCE_NOT_FOUND. Repository list predicates filter before counts/pagination;
detail predicates include company and object identity. Foreign user/order
parentage and mixed-tenant pages are refused before serialization. A changed
backend membership takes effect on the next admission; suspended/deactivated
customer identity or company denies. Already-admitted work may finish.

Malformed provider data/missing capability/required repository failure is 503
COMPANY_QUERY_UNAVAILABLE without fallback or raw driver detail. #32 admission
errors remain 401 INVALID_SESSION, 403 PASSWORD_CHANGE_REQUIRED/FORBIDDEN and 503
AUTH_UNAVAILABLE. No business data is returned with an error.

## Public projections

Explicit allowlists live in `packages/contracts/src/portal-reads.ts`; repository
objects do not pass directly through HTTP.

- Company: id, legalName, tradeName, status, erpCustomerReference.
- Customer user: id, companyId, displayName, customer role and status.
- Catalog product: id, sku, name, sellingUom, minimumOrderQuantity and price
  {amount,currency} or null. Quantities/prices are exact decimal strings. Eligibility
  and customer-specific effective pricing remain repository/ERP-cache concerns.
- Order: id, companyId, orderNumber, createdAt, business status and integration
  status enum. Creator IDs, snapshots, internal notes and ERP error details are
  excluded.

These are the seven current read projections. Advanced catalog filters,
availability/stock quantities, order lines, invoices, company administration and
mutations remain their owning issues. A missing field/endpoint must not be
invented by a consumer or treated as accepted fixture integration.

## Dependencies and verification

This clean integration branch starts from main 862efce and replays only the reviewed #33 delta from #155 / 5360fae. #155 had merged into codex/32-rbac after #153 was already on main, so a main integration PR is required. Current main reset and Mock catalog/submission features are preserved. The customer catalog #47 successor will explicitly target this integration branch; integrate this producer before retargeting/merging that successor. No PR is merged by this branch preparation. No migration, secret, provisioning, assignment write
or deployment is included.

Tests exercise both customer roles and two companies through actual HTTP,
company-specific prices/eligibility, list counts/paging and detail ownership,
foreign parent/child identifiers, current membership, lifecycle denial, Internal
Admin history, Sales fail-closed behavior, malformed input, private field/log
allowlists and provider failure. Direct service checks reject copied capabilities
and corrupt cross-company rows. SQL/JSON output parity is checked with real
adapters. Independent review remains required.
