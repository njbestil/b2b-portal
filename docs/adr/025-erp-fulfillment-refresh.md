# ADR-025: Independent, monotonic ERP fulfillment refresh

- Status: Proposed
- Related issue: njbestil/b2b-portal#66
- Foundations: settled #134 Mock fulfillment contract and merged #62 submission

## Context and options

Portal Confirmed/Fulfilling/Delivered business states require verified ERP
fulfillment evidence. Technical delivery/retry state and invoice availability do
not prove business fulfillment. Automatic polling or dispatch changes would
expand scope and overlap #63/#64. A health-only gateway cannot supply fulfillment.

## Decision

Add a neutral fulfillment source, strict existing Mock adapter and an explicit
bounded Internal Admin refresh capability. Capture server-owned order/customer
ERP linkage with current actor authority before I/O; revalidate both authority
and current linkage under provider write ownership afterward. Translate only
confirmed/fulfilling/delivered, with canonical finite nonfuture source time.

Use monotonic business ranks SUBMITTED→CONFIRMED→FULFILLING→DELIVERED, permitting
forward skips and verified equal no-ops. Refuse regressions and changes from
cancelled/rejected/draft/pending states; Delivered admits only equal no-op.
Change only business status; preserve updatedAt, technical status, integration
transactions/attempts, snapshots and every other order field. No technical SUCCESS
prerequisite or integration-table access/locks are introduced. Admin may record
verified fulfillment for linked companies in any lifecycle as historical truth;
this grants no customer/Sales business access.

SQL uses short company→actor→session→order transactions around capture/apply,
with expiry rechecks after waits and before commit. JSON uses the current
coordinator and semantic raw/validated equality to refuse unsupported private
fields, then a complete atomic status-only replacement with a pre-rename check.
Known committed publication reaches the required post-publication audit attempt;
post-commit expiry/cancellation is not represented as rollback. Unknown
publication/audit outcome is a safe unconfirmed 503. Equal no-op is not an audit
repair mechanism. Four actual refresh operations retain slots through disconnect
until async settlement; parsing/rate/cancellation remain bounded.

## Consequences and verification

No migration, dependency, poller, Mock producer rewrite, technical dispatch/retry
policy, UI or production integration is added. Existing linked JSON fixtures can
refresh without pretending JSON #62 submission exists. Mock runtime is explicit
nonproduction only, and source reset/down/failure never authorizes a transition.
Per-operation current checks leave already-admitted work its established boundary.
Source timestamps are validated but not persisted as a new checkpoint; monotonic
business rank prevents state regressions.

Verify real SQL/JSON/Mock/HTTP and #62 submission, technical independence, strict
correlation/time, current actor/session/expiry, terminal/concurrent/wait behavior,
rollback, private preservation, atomic publication, bounded cancellation/capacity
and audit uncertainty. This ADR remains Proposed pending owner acceptance and
review; it implies no merge, deployment or security-policy approval.
