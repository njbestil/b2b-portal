# Audit logging service (B2B-077)

The selected storage runtime exposes a separate backend-only append capability,
`audit`, backed by the existing `audit_logs` PostgreSQL table or a private
`audit_logs.json` file. `createAudit(repository, newId, now?)` captures a generated
UUID/UTC timestamp with the trusted actor ID/role snapshot, company scope, action,
target type/ID and metadata. Anonymous/system events use null actor ID and role.
Customer actors require company context. This is a record of a trusted backend
event, not authentication or proof of object authorization.

Metadata is deliberately not an arbitrary request/response dump. Allowed keys:
UUID `requestId`, `transactionId`, `orderId`; bounded uppercase `reasonCode`;
`outcome` success/failure/denied; and bounded `changedFields` from the documented
status/role/company/assignment/address/active field allowlist in the validator.
Unknown keys, credentials, email, free-form messages and before/after payloads
are rejected, not persisted or echoed. Action and entity names are bounded code
identifiers chosen by backend services. Never pass HTTP bodies or exception text.

Both adapters validate/detach input before I/O and preserve exact logical fields.
SQL uses parameterized append with existing FK constraints; JSON checks referenced
users/companies, serializes append operations and publishes a complete array by
atomic rename. Use one JSON instance/process per trusted directory. Missing audit
file means no prior events; reads are private implementation details and do not
create a file. Corrupt data, duplicate IDs, missing references or publication
failure reject with controlled errors. Failures propagate; no silent drop, retry
or runtime provider fallback. There is no cross-business-operation transaction or
distributed crash-durability claim for this initial append port.

No customer/public audit query, edit/delete endpoint, admin viewer or broad feature
integration is added. B2B-078 owns business-event integration; B2B-082 owns the
authorized admin viewer. Audit history is separate from migration history. No new
SQL migration/dependency is required. Readiness remains scoped to current read
collections, not proof of future audit write permission.

Explicit confirmed **disposable demo reset** now also clears the known private
audit file. SQL reset already clears audit_logs within its transaction. Unknown
files/tables remain refused; ordinary startup never resets audit history. JSON
remains local/demo state on ephemeral hosting, not a durable security ledger.

Run `npm run check`. `audit.test.mjs` verifies field capture, injected clock/ID,
metadata rejection, detached concurrent append/reopen, safe failures, references,
reset compatibility and parameterization. Existing isolated-schema PostgreSQL
opt-in proves actual SQL/JSON parity and FK behavior, with cleanup.
