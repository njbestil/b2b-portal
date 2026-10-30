# Internal order note persistence (B2B-014)

Migration `0002_order_internal_notes.sql` adds the separate internal table with
UUID ID, company/order composite FK, author FK, bounded nonblank note and finite
UTC timestamp. Apply it explicitly through the existing migration command to an
authorized target. Existing migration 0001 is unchanged. No backfill or customer
order projection/schema is modified.

The selected storage runtime exposes `internalNotes` as a **separate internal
capability**, not part of customer `repositories.orders`. Both adapters support
append and company/order-scoped, stable paginated reads. PostgreSQL uses the same
selected pool, parameterized statements and actor/order validation; there is no
runtime JSON fallback. JSON writes a separate `order_internal_notes.json` via
serialized read/append/atomic rename, retaining author/time across reopen. An
absent private note file means no notes and is never created by a read. Missing
user/order files, corrupt notes or publication failures are controlled errors.
Use one notes adapter instance per trusted directory/process, not multiple writers
or live offline resets. Hosted JSON is still disposable, not durable persistence.

`createInternalNotes(repository, authorize, newId, now?)` requires a trusted backend identity,
an explicit object/assignment authorizer and injected UUID generation. It rejects Customer Admin, Customer
User, unknown and inactive identities before authorization/repository I/O. No
default-allow authorizer exists. The selected company scope must come from backend
authorization, never a customer-supplied scope/role. Each adapter revalidates the
actual stored author as an active Internal Admin or Sales Staff and the order in
that company. The service creates UUID/time and binds author to actor; clients
cannot select another author. Note text is plain data, not trusted HTML.

This is persistence groundwork, **not** an authenticated HTTP API or the full
Sales workflow. B2B-020/022 supply real backend role/assignment checks; B2B-059
supplies the later Sales note workflow/UI. Do not wire a callback that trusts HTTP
input or returns true for arbitrary Sales companies. No new public endpoint is
registered. Customer order summaries remain note-free; database/filesystem access
is trusted infrastructure access, not customer access. SQL roles are not claimed
as a new RLS/security sandbox.

Notes are append-only in this initial port; edits, deletion and business audit
integration are not added. Storage readiness continues checking the current six
read collections/read schema, not proving internal-note write permission or
future workflow authorization. An unmigrated notes table produces a controlled
internal storage failure rather than fallback. All error messages are fixed and
exclude driver SQL, file paths and note contents.

Run `npm run check`. `internal-notes.test.mjs` verifies customer denial before I/O,
required authorization, reference/tenant constraints, note validation, detached
results, concurrent append/reopen, corruption and unchanged customer projections.
`B2B_TEST_MIGRATIONS_DATABASE_URL` enables isolated-schema PostgreSQL tests for
migration upgrade/rerun, FK/check constraints and adapter parity. No live user or
production data is needed. Normal seed/reset must refuse an unknown private note
file/table until it explicitly supports that extension; never silently delete it.
