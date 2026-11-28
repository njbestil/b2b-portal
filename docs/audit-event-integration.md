# Audit event integration (B2B-078 / #90)

Frozen requirement 3.4 is implemented by the existing feature producers. Their
startup composition passes the selected provider's `createAudit(...).record`
port into business services; submission, cancellation and manual retry publish
their required audit in the same SQL transaction as the local transition. This
issue adds composed acceptance coverage and completes the event map. Adding a
second generic middleware emitter would duplicate these trusted business events.

| Required family                     | Actual events                                                                                                                                                                                                  | Producer / acceptance evidence                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Login and security                  | `login.succeeded`, `login.failed`, `session.issued`, `session.refreshed`, `session.revoked`                                                                                                                    | `login.ts`, `sessions.ts`; `audit-integration`, `login`, `sessions`, `logout` tests   |
| Password security                   | `password.change_denied`, `password.changed`, `password.reset_requested`, `password.reset_issued`, `password.reset_completed`                                                                                  | `password-change.ts`, `password-reset.ts`; password change/reset tests                |
| Customer approval and rejection     | `application.received`, `application.approved`, `application.rejected`                                                                                                                                         | `applications.ts`, `application-decisions.ts`; application/application-decision tests |
| Account activation and suspension   | `company.suspended`, `company.reactivated`, `user.suspended`, `user.reactivated`                                                                                                                               | `account-status.ts`; composed integration and account-status tests                    |
| User lifecycle                      | `user.created`, `user.deactivated`, `sales_staff.created`, `sales_staff.activated`, `sales_staff.deactivated`                                                                                                  | `customer-users.ts`, `sales-staff.ts`; composed integration and user/staff tests      |
| Sales assignment and reassignment   | `sales_assignment.assigned`, `sales_assignment.reassigned`                                                                                                                                                     | `admin-sales-assignments.ts`; composed integration and assignment tests               |
| Order creation and editing          | `order.created`, `order.draft_updated`, `order.draft_deleted`, `order.draft_item_added`, `order.draft_item_updated`, `order.draft_item_removed`, `order.draft_terms_acknowledged`, `order.internal_note_added` | draft/note services; composed integration and draft/item/note tests                   |
| Submission and fulfillment          | `order.submitted`, `order.fulfillment_updated`                                                                                                                                                                 | PostgreSQL submission, fulfillment service; submission-integration/fulfillment tests  |
| Customer confirmation               | `order.confirmation_requested`, `order.customer_confirmed`, `order.customer_rejected`                                                                                                                          | confirmation services; request/customer-confirmation tests                            |
| Cancellation request and result     | `order.cancellation_requested`, `order.cancellation_completed` (local), `order.cancellation_decided` (ERP decision)                                                                                            | PostgreSQL cancellation; cancellation tests                                           |
| ERP retry / important admin changes | `integration.retry_requested` plus account, staff and assignment events above                                                                                                                                  | PostgreSQL manual retry; manual-retry and composed integration tests                  |

Each audit record carries its generated UUID and canonical UTC time, actor ID
and role, company scope where relevant, action, target type/ID and bounded
metadata. Request/transaction/order UUIDs correlate operations. Login denial
uses an anonymous actor and target so account enumeration or attacker-supplied
identity never becomes a trusted actor. Session issuance is distinct from login
verification; do not add another `login.succeeded` at the route boundary.

Metadata follows the existing allowlist: IDs, outcome, code and known changed
field names. No passwords, hashes, access/refresh/reset tokens, customer email,
free-text reason, internal note, provider payload or exception text is copied.
The richer operational integration ledger remains separate from audit records.

Denied, invalid and stale business commands must not produce success events.
The append port does not retry failed writes or switch providers at runtime.
Post-commit service audit failure returns an unconfirmed result; it cannot undo
an already committed account/order/user change. Re-read state before another
command. Application decision effects retain their own pending/unknown/completed
state and never blindly repeat an uncertain audit. Submission, cancellation and
manual retry instead roll their local SQL transition back if required audit
publication fails, before external I/O. A retained unknown ERP outcome is not a
business cancellation result and must not invent a decided event.

Existing service replays can log successful command observations; the append
port is not a global exactly-once transition ledger. Transactional initial
submission/cancellation and a successful manual-retry claim have one audit per
actual transition, even with concurrent/replayed commands. The tests preserve
those boundaries rather than silently changing replay contracts.

`audit-integration.test.mjs` runs real composed JSON and PostgreSQL producers,
checks required families, exact counts for transitions, trusted actor/scope,
targets, metadata and credential exclusion, and rejects success emissions for
denied/stale commands. Existing actual Mock submission/cancellation/retry tests
now check those same actor/target/correlation fields as well as state and I/O.
Their failure tests cover audit rollback or an explicitly retained unconfirmed
result. The normal `npm run check` discovers all this coverage; enable all three
documented PostgreSQL/migration test URLs to avoid SQL skips.

No new event middleware, dependency, migration, audit viewer, notification or
deployment behavior is introduced. JSON remains one process per trusted directory
and disposable on ephemeral hosting. JSON cancellation and production ERP retain
their existing provider gates until their separate issues are reviewed and merged.
