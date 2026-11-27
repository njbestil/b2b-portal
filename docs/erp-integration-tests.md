# ERP integration acceptance (#98 / B2B-086)

`npm run test:erp` builds the actual Portal/Mock applications and runs the ERP
workflow and existing integration/retry/fulfillment suites serially. Set
`B2B_TEST_MIGRATIONS_DATABASE_URL` to an explicitly disposable PostgreSQL target
before running it. Tests use isolated schemas and real loopback HTTP; PostgreSQL
checks are reported as skipped if the URL is absent. No production target,
provider enabling, migration change, new dependency or recovery policy is added.

The new `erp-workflow.test.mjs` exercises the composed authenticated Portal route,
normal draft creation/items/commercial acknowledgement, SQL snapshot/reservation,
durable dispatch, bounded retry gateway and real Mock HTTP adapter together.

| Acceptance         | Composed evidence                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Success            | Real Mock order/reference, retained transaction/request/snapshot, no private ERP fields in the Portal response                     |
| Idempotency        | Concurrent same-key HTTP requests, replay through a new Portal app, conflicting actor/key denied without another send              |
| Timeout and retry  | Correlated no-effect Mock timeout/unavailability followed by success; identical retained payload and 100/200-ms allocated backoff  |
| Retry limit        | Exhaustion makes exactly initial + configured retry attempts, keeps the business order submitted and never resets budget on replay |
| Business rejection | Credit hold retained as terminal technical failure, no retries or invented business-state transition                               |
| Unknown outcome    | Mock accepts but its response socket is dropped; replay after both app resets and manual retry cannot send again                   |

The injected wait records the scheduler's allocated backoff without sleeping;
the correlated Mock timeout is a real HTTP fixture. A response interceptor exists
only inside this test's local Mock wrapper to lose an already-created receipt.
Neither production app gains scenario headers, failure hooks or bypasses.

Existing suites remain responsible for malformed/untrusted provider responses,
interrupted claims, SQL publication failure, exact decimal/snapshot rules,
manual-retry current authority and fulfillment mapping. This is local acceptance
evidence, not CI, production, automatic reconciliation or an exactly-once guarantee
across Mock process loss. Unknown outcomes still need explicit reconciliation.
