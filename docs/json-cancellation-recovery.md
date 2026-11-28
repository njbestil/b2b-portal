# Recoverable JSON cancellation (#195)

JSON now implements the existing cancellation command and status contracts.
Normal Customer Admin/User and currently assigned active Sales Staff retain the
same required reason, company boundary, delivered/terminal-order exclusion and
draft-creator rules. Actor, session, company, assignment and access expiry are
re-read inside the shared JSON coordinator before each publication. An unsent
draft or pending-confirmation order can be cancelled locally. A linked submitted,
confirmed or fulfilling order needs the configured nonproduction Mock gateway.
Unlinked or in-flight/ambiguous submitted JSON orders fail closed: JSON submission
is still unavailable, so this implementation cannot prove an unsent submission
transaction can be stopped safely. PostgreSQL retains its existing transactional
stop-before-send path.

The private `order_cancellations.json` ledger retains request ID, company/order/
actor, hashed key and reason identity, normalized private reason, business result,
required audit evidence and one attempt ID/correlated outbound request. Its
canonical validator refuses unknown fields, inconsistent decisions, duplicate
identities/active cancellations/attempt IDs and missing audit evidence. The public
API returns only request ID, order ID and PENDING/APPROVED/REJECTED. It exposes no
reason, hashes, provider data or attempt payload.

`cancellation_publication_intent.json` contains a versioned before/after plan for
exactly `orders.json`, `audit_logs.json` and `order_cancellations.json`. Each
complete temporary file is synced before atomic rename. The intent is published
first; its three files follow; the intent is removed last. Recovery validates the
whole plan and all current files before changing any. Each current file must
match its recorded before or after bytes. It preserves existing ledger identity,
audit prefixes, ERP correlations and terminal outcomes, and permits only the
correlated cancellation order transition. Unknown private order fields are
refused rather than projected away. Existing snapshots, confirmation records,
items, acknowledged terms and separate internal-note files remain intact.

Startup attempts local recovery and records only `cancellations.recovery_failed`
on failure. Every coordinated operation also recovers before reading or writing.
Uncoordinated collection reads/replacements fail closed while an intent exists.
The selected runtime injects its same coordinator into audit append and all
business writers, so audit append cannot race a cancellation publication. Recovery
performs local file publication only; it never calls ERP or makes a new business
decision. A missing/corrupt/conflicting plan leaves the data and intent for review;
it does not fall back to another provider or erase files.

For ERP cancellation, the first publication retains a PENDING attempt. A second
publication marks it PROCESSING before the gateway is called. Only PENDING may
be claimed. A crash after that durable claim, even before any send can be proven,
stays pending for reconciliation. An unknown/unverified result retains FAILED with
an unknown decision and leaves the order unchanged. Neither state is resent,
including after Portal or Mock restart. A verified approval/rejection is published
with its required result audit; approval changes only business status to CANCELLED,
while rejection preserves the order. Technical submission status is preserved.
Changed authority, order status or ERP linkage during network I/O refuses a stale
result instead of overwriting the current state. Replays recheck current authority
and retain the original actor, normalized reason and request identity.

After an uncertain HTTP result, check cancellation status. Never remove a pending
intent or clear a PROCESSING/unknown attempt to enable another send. Stop writers
and preserve the ledger, intent and all three files for reconciliation if recovery
refuses drift or corruption. There is no automatic reconciliation or retry endpoint
for unknown outcomes. An approved ERP cancellation with an unconfirmed local result
may therefore require operator investigation before any further business action.

Use exactly one runtime/coordinator per trusted directory/process. All online
writers must use that injected coordinator. External tools, catalog refresh,
credential provisioning and demo reset require all online writers stopped.
Offline account/catalog directory swaps preserve the ledger bytes. Pending intents
remain unknown files to those tools and are refused. Only an explicitly confirmed
disposable demo reset clears the known ledger together with order/audit history.
No system service, production provider, SQL migration or repository dependency is
added. JSON submission, integration monitoring and manual ERP retry remain gated.

Cancellation publication bounds each data file to 10 MiB, the encoded intent to 65 MiB, and the ledger
to 5,000 requests. This is process-interruption/restart recovery on the retained
trusted filesystem, not distributed concurrency, storage-device power-loss
guarantees or hosted persistence. Render's ephemeral filesystem remains disposable;
losing the entire directory loses these records. Review the proposed recovery
boundary before merging/enabling this implementation in a shared environment.

`json-cancellation.test.mjs` covers both actual providers and Mock ERP, scoped HTTP,
live authority, competing requests and order edits, all local publication steps,
rename failure before/after publication, actual child termination after claim,
Mock restart, startup/corrupt-plan recovery, late authoritative state changes,
private snapshots/confirmation/notes, audit append and offline account/catalog/reset
compatibility. Existing cancellation, audit, authorization, fulfillment, credential
and storage tests remain required regressions in `npm run check`.
