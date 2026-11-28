# ADR 034: Confirmed assisted orders use normal submission

Status: Proposed
Related: njbestil/b2b-portal#74

Extend the existing PostgreSQL submission transaction, immutable snapshot helper,
dispatcher and retry gateway with a verified confirmation binding. Preserve the
Sales creator and record the actual customer approver as submitted-by. The
snapshot helper independently checks the retained CONFIRMED record before
allowing those two identities to differ. No caller-supplied authorization flag
or synthetic Sales principal substitutes for the customer decision.

Sales drafts deliberately have no customer commercial acknowledgement. After
confirming, the deciding customer reviews a live quote and explicitly accepts
its content token before the initial submission. Preview uses the normal
preparation transaction with rollback before publication. Submission revalidates
and compares that token; successful publication uses the existing atomic ledger,
snapshot, audit and outbound request boundary. A confirmation-derived reservation
key prevents alternate client keys from creating another identity.

Avoid a separate Sales dispatcher, automatic price acceptance or changing draft
ownership. The customer confirmation consumer gains only the quote and explicit
submission step within its established feature, shared controls and ZIP design.
No layout framework, schema, production provider or JSON submission change.

The existing unreserved catalog read and Mock restart limitations remain. Review
the proposed extension and its acceptance evidence before merge; this does not
authorize production deployment or claim exactly-once ERP effects.
