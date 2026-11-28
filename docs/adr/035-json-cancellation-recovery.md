# ADR 035: Recoverable JSON cancellation publication

Status: Proposed
Related: njbestil/b2b-portal#195

The owner-approved JSON parity follow-up requires cancellation identity, business
state, audit and one-attempt ERP correlation to survive interruption together.
Reuse the existing trusted-directory coordinator and atomic-file conventions.
Retain the private request/attempt and required audit evidence in a canonical
ledger, then publish order/audit/ledger through a bounded before/after intent.
Recover that intent before any coordinated work; refuse mismatched files or
unknown private data rather than overwriting them. Plain collection access refuses
a pending intent. Inject the same coordinator into the runtime audit adapter.

Commit a PROCESSING claim before external I/O. Never reclaim it after interruption
or retry an unknown result, since Mock receipts disappear on restart. Recovery is
local publication, not another ERP attempt. Verified results recheck current
authority, business state and correlation, then publish the result and audit
together. Direct local cancellations use the same recoverable boundary.

Avoid independent order/audit writes, an in-memory attempt ledger, automatic retry
after restart, or enabling unproven JSON submission. Keep one online process per
directory and stop it for external/offline writers. Account/catalog swaps preserve
the ledger; explicit disposable reset clears it; pending intents refuse those
offline workflows. No dependency, schema migration or infrastructure service.

The cost is bounded whole-file copying and temporary unavailability during failed
publication. Unknown outcomes remain pending until manual reconciliation. Retained
file recovery does not make ephemeral hosting durable or guarantee power-loss
semantics. Verification includes actual process termination, JSON/SQL/Mock parity,
publication failures, current authorization, private fields and existing writers.
Independent owner review remains required before merge or shared enablement.
