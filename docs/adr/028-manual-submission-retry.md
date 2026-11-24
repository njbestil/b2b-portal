# ADR-028: Explicit manual retries after automatic exhaustion

- Status: Proposed — implementation review pending
- Related issue: #86 / B2B-074

The frozen requirements explicitly permit Internal Admin to manually retry
retryable failures after the automatic limit. Keep the existing automatic
allowlist: only correlated Mock technical rejections that guarantee no remote
order was created are retryable. Preserve this flag on the dispatcher's final
FAILED row; unknown outcomes and business rejections remain nonretryable.

An authenticated Internal Admin posts the transaction's observed retryCount and
updatedAt. Under the existing company/account/session/transaction/order lock
order, revalidate authority, active company, unchanged failed submission state,
retained no-effect response and original bounded request. Both count and timestamp
must match; the monotonic count prevents duplicate commands even where public
timestamps share a millisecond. A stale command conflicts instead of retrying.

Atomically increment the retained count, move transaction/order technical state
back to PENDING, and append required actor audit. Commit before dispatch; invoke
the existing single-claim dispatcher with the plain provider for exactly one
manual attempt. Do not reset the automatic budget or create a parallel send path.
Business status and immutable submitted commercial values remain unchanged.

If publication or the connection is uncertain, report unavailable and require a
canonical reread. A retained PENDING/PROCESSING/unknown result cannot be manually
reclaimed. A cancelled/already linked order, suspended company, stale/revoked
Admin or non-submission operation cannot be sent. Existing lifecycle locks decide
races; a cancellation that wins after admission may stop a PENDING send.

No new tables, background jobs, provider or permission for Sales/customers are
introduced. Production and JSON remain unavailable for this operation; the Mock
is development/test only. The process-local route limit is five commands per
Admin per minute and two concurrent commands. Every additional retry is another
explicit, freshly versioned Admin command. Human review remains pending.
