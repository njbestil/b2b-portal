# ADR-007: Company-scoped read authorization

- **Status:** Proposed
- **Related Issue:** njbestil/b2b-portal#33

## Context

Frozen requirements restrict both customer roles to one company, Sales Staff to
active assignments, and Internal Admin to platform-wide visibility. #32 separates
role permission from ownership; existing read ports require an authorized scope
but cannot treat a caller-selected company ID as authentication.

## Options considered

Directly exposing scope-accepting ports would trust request selectors. Filtering
after pagination can leak counts and omit matching records. A service boundary
that derives scope from a backend actor and retains repository predicates allows
the existing adapters to enforce tenant queries before pagination.

## Decision

Propose the explicit ownership matrix in [tenant-isolation.md](../tenant-isolation.md).
Require #32's runtime actor in every service; customer URL company must match its
current company. Internal Admin may select an existing company. Sales resource
access denies until #34 provides real assignment enforcement. Keep company/object
predicates in the selected repository and use explicit public allowlists.
This implements the authorized isolation task; independent acceptance remains
pending.

## Consequences and risks

Every future endpoint needs role plus ownership checks, including list counts and
parent/child lookups. These routes cover only the seven existing read projections,
not unimplemented order lines/invoices/mutations. Request actors must not be
retained across admissions. Provider failures never trigger a fallback.

## Migration / verification

No migration. Use two-company actual PostgreSQL/JSON HTTP and service tests,
including pricing, counts, foreign IDs, membership/lifecycle, private projections
and failure behavior. Verify the stack against #32's exact head before review.
