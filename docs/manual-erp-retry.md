# Manual ERP retry (#86)

Internal Admin may POST /api/v1/admin/integration-transactions/:id/retry with
exactly `{ "retryCount": 2, "updatedAt": "2026-11-24T12:00:00.000Z" }` from a
fresh monitoring GET. Success is 202 with `{transactionId}` in the standard
no-store envelope; it confirms the command, not ERP acceptance. Reread monitoring.

Only FAILED ORDER_SUBMISSION rows marked retryable with a retained, correlated
no-effect technical rejection are eligible. The automatic limit may already be
exhausted. One explicit command uses the retained original request for one further
attempt and increments retryCount; it never resets automatic counters or changes
submitted commercial snapshots. Business, unknown, in-flight, accepted, cancelled
or inconsistent results refuse. A duplicate/stale version returns 409.

Current persisted Admin/account/session and company/order state are checked under
locks. Claim, count and required audit commit together before the existing
single-claim dispatcher sends. Lost acknowledgement or worker interruption may
require reconciliation. Do not automatically retry a failed command or reclaim
PENDING/PROCESSING/OUTCOME_UNKNOWN. No raw provider payload/error is returned.

The existing Mock source is available only in development/test with PostgreSQL;
JSON and production respond 503. No migration or configuration is added. The
guard allows five commands per Admin per minute and two concurrent operations;
existing API and Bearer limits also apply. See ADR-028 for review status.
