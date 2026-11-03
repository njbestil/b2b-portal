# ADR-010: Own-company Customer User provisioning

- Status: Proposed
- Related issue: #41
- Existing foundations: accepted ADR-003 and the #28/#30/#31/#32/#33/#42 producers

## Context

The frozen role matrix permits Customer Admin to create/deactivate Customer
Users only in their own company. Credential-update helpers intentionally clear
the first-login flag and therefore cannot implement new-user creation.

## Decision

Use a separate private selected-provider mutation capability behind opaque actor
authorization. Derive company and fixed role server-side. Accept the
administrator's temporary password through the existing bounded secret-input
pattern, persist only the accepted hash and force the existing first-login flow.
No secret-response or outbound delivery channel is introduced.

Check current actor/account/company/session authority within provider write
ownership. SQL uses existing company/user/session lock order, one transaction
and an expiry recheck after statement waits. JSON uses the shared coordinator,
refuses unresolved application intents and publishes DEACTIVATED before cleanup.
Permanent deactivation retains credentials and history; it never reactivates.

## Alternatives and consequences

Reusing generic Internal Admin suspension would widen the permitted role/target
and lifecycle boundary. Reusing password-change publication would clear the
required temporary-password flag. Neither is used. New creation is globally
email-unique and has a bounded hash cost.

Post-publication audit failure leaves an unconfirmed committed result, matching
the existing lifecycle producer. A client refreshes before retry. JSON has
per-file atomic publication, not a distributed transaction. One trusted writer
coordinator/process per directory remains required.

## Migration and verification

Reuse existing users/session fields and constraints; no migration/dependency is
needed. Run actual SQL/JSON, first-login, role/company, race, failure/restart and
privacy checks plus the repository check. Human review of this implementation
and proposed ADR remains pending; no production or merge approval is implied.
