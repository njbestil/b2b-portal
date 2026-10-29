# Portal API repository contracts

The initial core read ports live in `src/repositories/`: `CompanyRepository`,
`UserRepository`, `CatalogRepository` and `OrderRepository`. Internal application
query services in `src/services/` consume these interfaces through constructor-like
factory injection, with no concrete provider imports. They are not wired to HTTP
routes until authentication, authorization and storage providers exist.

These are deliberately small **read projections**, not database schemas, complete
entities or public API DTOs. Keep them inside the API; `packages/contracts` remains
for transport types only. Extend ports alongside the feature that needs an operation
rather than inventing a universal CRUD interface now. Writes, authentication/session
storage, order snapshots/items, confirmations, cancellations, integration transactions,
notifications and audit ports belong with their respective workflows. This foundation
does not implement those workflows, ERP calls, migrations or persistence adapters.

## Contract semantics for both PostgreSQL and JSON adapters

- Every operation returns a Promise of plain logical data. No SQL, pools, rows,
  filesystem paths, callbacks or HTTP objects cross this boundary.
- IDs are logical UUID strings; timestamps are UTC ISO-8601 strings. Decimal amounts
  and quantities are exact base-10 strings (e.g. `"0.125"` KG), never floating-point
  database-driver values or integer-only quantities.
- Every lookup/list requires a `CompanyScope`. A caller must derive this from
  backend authorization, never an unchecked customer request parameter. Sales
  assignment and internal-admin authorization remain the caller's responsibility;
  possession of a scope object is not proof of authorization.
- Adapters must apply company predicates **before lookup, filtering, counting and
  pagination**. Missing/out-of-scope records resolve to `null`; empty collections
  resolve to `{ items: [], total: 0 }`. No unscoped fallback queries.
- Lists use a zero-based offset and a limit of 1–100. Query services default to
  `{ offset: 0, limit: 20 }` and reject invalid ranges before calling a repository.
  `total` counts all matching company-scoped rows, before slicing. Users/catalog
  sort by ID ascending; orders sort by creation time descending, then ID ascending.
- Catalog reads expose only eligible, active products and that company's resolved,
  currently valid customer/default price (or `null` when no valid price exists).
  ERP remains authoritative. Browsing reads do not replace submit-time revalidation.
- Order business status and technical integration status are distinct types. Summary
  reads exclude internal notes and raw ERP errors; later detail reads must preserve
  submitted snapshots instead of joining mutable product/address values.
- Storage failures reject. Do not convert them to missing/empty results or switch
  providers after a runtime failure. Startup provider selection is separate work.
- Results are readonly to consumers; adapters must return detached data so a consumer
  cannot mutate persisted state through a returned object.

Run `npm test --workspace=@b2b-portal/api` for application query tests and TypeScript
contract fixtures. Test doubles are test-only: no production JSON/SQL adapter or
provider health probe is introduced by these contracts.
