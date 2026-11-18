# ADR-020: Internal Admin customer directory

- **Status:** Proposed
- **Related Issue:** njbestil/b2b-portal#82

## Context

Customer management needs discovery of customer companies across lifecycle
states. Existing tenant-scoped company reads require a known company ID. Merged
application review and account-status services already own activation,
suspension, audit and session effects.

## Options considered

1. Expand tenant company reads with an unscoped selector.
2. Add a dedicated Internal Admin directory using a private authenticated port.

## Decision

Propose a dedicated read-only `GET /api/v1/admin/companies` directory. Reuse the
existing Internal Admin account-status read permission and company summary
allowlist. Both selected storage providers revalidate current account,
credential-bound session and access expiry at the persistence operation.
PostgreSQL count/page/authority share one statement snapshot; JSON uses the
shared security coordinator. Keep all writes in the existing lifecycle services.

## Consequences and risks

Inactive companies remain discoverable to Internal Admin. No cross-company
access is granted to customer or Sales roles. Offset pages can move between
requests when companies change; each response has its own coherent total/page.
This adds no schema, infrastructure or ERP-owned field changes. The API contract
is documented in [customer management](../customer-management-api.md); independent
review of this proposal and implementation remains pending.

## Migration / verification

No migration. Verify SQL/JSON and HTTP acceptance, role/privacy guards,
post-wait authority checks and existing account-status regressions.
