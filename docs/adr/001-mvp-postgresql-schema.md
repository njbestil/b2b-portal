# ADR-001: Physical PostgreSQL mapping of the approved MVP model

- Status: Proposed — implementation review pending; not production migration approval
- Related Issue: [B2B-010 / #22](https://github.com/njbestil/b2b-portal/issues/22)

## Context

Sections 3.8–3.9 of the product's requirements freeze 17 core entities, UUID keys,
foreign keys, statuses, uniqueness, query indexes and NUMERIC quantities. Existing
backend repository types are read projections, explicitly not full entities.
B2B-009 provides a transactional, checksummed migration runner but no business DDL.
This ADR records the physical mapping for review, not a new logical architecture.

## Options considered

- Persist only the six existing JSON projections: insufficient for the approved
  logical model and future auth, assignment and order workflows.
- Introduce an ORM or unversioned schema synchronization: unnecessary dependencies
  and conflicts with the approved ordered SQL migration process.
- One explicit initial SQL migration for the frozen model: chosen. Subsequent
  feature-specific changes must append new versions after this file is applied.

## Decision

`apps/api/migrations/0001_mvp_schema.sql` creates these tables. All have application-
supplied UUID primary keys. No extension, UUID-generation function, sequence,
database role, grant, seed, reset or startup migration is added.

| Tables                                                           | Physical responsibility                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `companies`, `users`                                             | Tenant identity/profile/contact/address data, account statuses, four roles, email uniqueness and hashed credentials                                |
| `customer_sales_assignments`, `delivery_addresses`               | Extensible assignments, active primary/default uniqueness, company-owned delivery records                                                          |
| `products`, `customer_product_access`, `customer_product_prices` | ERP-owned synchronized cache/reference data; one access and override-price candidate per company/product pair                                      |
| `orders`, `order_items`                                          | Separate business/integration status, creator/address references, exact quantities/amounts, nullable submission identity and JSON snapshot objects |
| `order_confirmations`, `order_cancellation_requests`             | Designated company customer, decisions/reasons and one pending cancellation per order                                                              |
| `integration_transactions`, `invoices`                           | Unique transaction/ERP identities, retry metadata, private technical details, ERP invoice metadata/document reference                              |
| `notifications`, `audit_logs`                                    | User-scoped in-app records and actor/role/action/target/time/metadata audit records                                                                |
| `user_sessions`, `password_reset_tokens`                         | Unique hashed token references, expiry, revocation/use timestamps; never plaintext tokens                                                          |

`schema_migrations` remains owned by the existing runner and is separate from
`audit_logs`. Internal order notes are explicitly deferred to B2B-014 (#26).

### Constraints and query indexes

- Customer user roles require `company_id`; internal roles require it to be null.
  Account, business order and technical integration status values match the
  requirements and existing TypeScript ports. Those two order statuses are not
  coupled by any constraint.
- Case-insensitive email uniqueness uses `lower(email)`; surrounding spaces
  are rejected. Full email syntax/normalization remains input validation. Hash
  columns are nonempty storage fields, not implementations of
  hashing or authentication policy.
- A partial unique index enforces **at most one** active primary sales assignment
  per company; another prevents duplicate active company/sales pairs. Pending
  onboarding may have no assignment. Exactly-one assignment, staff roles and
  assigner authorization remain service invariants.
- A partial unique index permits at most one active default address per company;
  an inactive address cannot remain default.
- Company/order and company/address composite foreign keys reject mismatched
  tenant references for delivery, items, confirmations, cancellations, ERP
  transactions and invoices. Confirmation customer/decider references are also
  company-scoped. Creator/cancellation-actor FKs permit internal Sales Staff;
  their dynamic assignment and role permissions require backend authorization.
- Quantities and monetary values use unconstrained `NUMERIC`, preserving exact
  scale without implicit fixed-scale rounding. Positive/non-negative and finite
  checks reject zero quantities, negatives, NaN and infinities where applicable.
  Money may be zero. Application validators must still bound input size/scale
  and enforce selling-UOM, MOQ, stock and pricing rules.
- UUIDs/SKU/ERP identities, email, company/product pairs and idempotency keys have
  primary/unique constraints. Price windows must end after their start; no-price
  products may have null default price/currency and unknown stock stays null.
- B-tree indexes cover company/status and order/date pagination, sales assignments,
  catalog references, integration queues/status, invoices, user notifications,
  audit actor/target/action/company and session/reset expiry. Partial indexes cover
  unread notifications and retryable work. No full-text/search extension is added.

## Consequences and risks

ERP remains authoritative for commercial/customer/product data. The schema does
not expose tables over HTTP or grant customer database access. Composite FKs are
integrity constraints, **not** row-level authorization; tenant/role/assignment
checks remain mandatory in future backend operations. No RLS/security policy is
introduced or weakened.

JSON objects store flexible billing/delivery and order/item snapshots. The fields
are available but are not required for draft creation. B2B-044 and submission
services must validate snapshot contents and prevent post-submission mutation;
this migration does not implement immutable-order triggers or workflow transitions.
Likewise session rotation, one-use reset consumption, audit redaction, retry policy
and commercial validations remain their own features. `updated_at` is initialized,
not automatically maintained by triggers; writers must update it explicitly.

Foreign keys use PostgreSQL's default no-action deletion behavior. Deactivation
preserves historical references; there is no destructive cascade/reset operation.
Invoice status, credit status, payment terms, notification type and integration
operation remain provider/feature-owned text rather than invented frozen enums.

## Migration / verification

Run the existing explicit migration command only against a reviewed, authorized
target. Applying this initial file to pre-existing manually created business tables
fails closed; it does not silently adopt or overwrite them. The existing runner
publishes all pending DDL/history in one transaction and verifies history on rerun.

`apps/api/test/mvp-schema.test.mjs` loads the shipped file and, when the existing
`B2B_TEST_MIGRATIONS_DATABASE_URL` disposable-database opt-in is set, verifies real
empty-schema creation, table/key/index shape, valid records, rejected constraints,
tenant references, precise decimals, concurrent/rerun behavior and failed-batch
rollback. A separate `B2B_TEST_MIGRATIONS_CLI_DATABASE_URL` opt-in permits the CLI
test to create/drop a uniquely named temporary database using a disposable role
with `CREATEDB`. It tests the actual public-schema command without touching the
supplied database's public tables. The original opt-in remains schema-only and
does not require broader privileges.

Physical mapping remains Proposed until human PR review. Neither test success nor
PR creation authorizes applying this schema to production.

References: [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html),
[exact numeric and special values](https://www.postgresql.org/docs/current/datatype-numeric.html),
[partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html).
