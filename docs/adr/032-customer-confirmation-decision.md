# ADR 032: Customer decisions on assisted confirmations

Status: Proposed
Related: njbestil/b2b-portal#73

## Context and decision

The merged request producer retains one confirmation per order. Extend that
existing record with its final decision, actor, reason and time using the same
provider ownership boundary. Use a normal customer permission and designated
contact/Admin company checks. Keep request identity and an immutable first
decision for replay/conflict handling. Reuse existing SQL columns and atomically
extend the JSON order child; no separate JSON multi-file transaction is added.

Customer confirmation and ERP order confirmation are separate facts. A positive
decision leaves the business order awaiting submission; only #74 may revalidate
commercial rules and enter the normal ERP workflow. A negative decision records
REJECTED. Do not return to editable draft or silently replace the decision.

## Alternatives and consequences

Avoid a separate JSON decision collection, which would require recovery across
multiple files, and avoid an ERP send here, which belongs to #74. The request
fingerprint remains private. Customer review exposes descriptive items and
delivery only, without inventing a financial quote. Read current state after
an uncertain command; audit failure after publication does not imply rollback.
Future submission must explicitly preserve the confirmed record and validate
its own state transitions before enabling JSON or a production source.

## Verification

Actual JSON/PostgreSQL/HTTP tests cover scope, creator/roles, opposing races,
replay/reopen, live revocation/expiry, SQL rollback, JSON publication uncertainty
and existing writer preservation. Client/markup tests and browser QA cover the
customer decision interaction. Independent review remains pending.
