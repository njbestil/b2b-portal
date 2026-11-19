# ADR-024: Bounded retry after confirmed Mock non-publication

- Status: Proposed — independent review pending
- Related Issue: [#64](https://github.com/njbestil/b2b-portal/issues/64)

## Context

Mock submission outcomes distinguish a few correlated technical fixtures that guarantee no publication from unknown transport outcomes. Its receipt ledger is not durable across restarts.

## Options considered

Retry all transient-looking failures; never retry; or retry only explicitly confirmed no-effect responses while retaining the request and a bounded allocation. Unknown delivery cannot safely be retried against a restarted Mock.

## Decision

Use bounded exponential backoff inside the existing claimed dispatch. Persist each allocation before waiting, retain the same request, and retry only the documented correlated Mock technical fixtures. Do not reclaim an interrupted PROCESSING attempt automatically. The configured limit counts additional attempts.

## Consequences and risks

Process loss can leave work for reconciliation even when the last confirmed attempt had no effect. The initial HTTP operation waits during the bounded retry sequence. This is not a general-purpose persistent scheduler or a production ERP guarantee. No new table is required.

## Migration / verification

No migration. Verify recognized and malformed receipts, exact request reuse, bounded retries and backoff, exhausted budget, business rejection, unknown outcome, interruption, concurrent claims and configuration bounds. Existing unknown-outcome behavior must remain fail-closed.
