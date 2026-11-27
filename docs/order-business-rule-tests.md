# Order business-rule acceptance tests (#97 / B2B-085)

`apps/api/test/order-business-rules.test.mjs` composes actual draft repositories,
commercial acknowledgement, validation, retained snapshots and PostgreSQL
submission with a real local Mock ERP catalog/adapter. Its isolated fixtures
reuse the established synthetic authentication setup and migration opt-in.

Acceptance mapping:

- MOQ: current source changes block below-minimum quantities. Fractional quantities
  above MOQ are accepted without invented pack-multiple rules; quantities are
  canonical exact decimal strings, not binary floats.
- Pricing/account/stock: current changed price, currency mismatch, inactive
  account/product, zero and unknown stock invalidate a previously acknowledged
  draft without changing persisted items. Restoring source terms restores validity.
- Address: an address disabled after acknowledgement cannot validate or submit.
- Submission: every tested preflight failure leaves no order snapshot, submission
  reservation or integration transaction, and never calls ERP.
- Snapshot/idempotency: exact minimum value submits once under concurrent matching
  keys. Replay preserves one send and the original snapshot despite later catalog
  and delivery changes; another key cannot resubmit the order.
- Reorder: current terms/restrictions are reported on a separate unsent draft with
  fresh ownership/identity, copied quantities and no retained delivery address.
  The historical source snapshot stays unchanged.

Nine focused tests cover JSON/PostgreSQL validation parity, actual PostgreSQL
submission and JSON's internal snapshot component. JSON has no enabled full
submission/idempotency service; its snapshot test does not claim one. Existing
lower-level suites remain intact. Initial catalog reads and accepted dispatch use
the real local Mock transport. Controlled catalog snapshot ports vary commercial
conditions for negative cases; SQL and JSON repositories remain real. There are
no application, dependency or policy changes. Set disposable
B2B_TEST_MIGRATIONS_DATABASE_URL for PostgreSQL cases.
