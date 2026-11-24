# ADR-026: Safe read-only ERP transaction monitoring

- Status: Proposed
- Related issue: njbestil/b2b-portal#85
- Foundations: merged submission, technical status and bounded retry producers

## Context and options

Internal Admin needs to search and inspect pending/successful/failed technical
integration transactions. Raw provider payloads, arbitrary operation/error text,
keys and messages are not a safe monitoring DTO or search surface. Existing
transaction production is PostgreSQL-only; no JSON transaction collection exists.

Options are raw SQL-row exposure, a new invented JSON mirror/empty dashboard, or
a narrow selected-provider read capability with safe projection and bounded work.

## Decision

Add Internal Admin-only list/detail with UUID company/order filters, exact
technical status, bounded paging and literal q search over safe projected fields.
Expose only IDs, fixed operation/error labels, technical status, retained retry
metadata and finite timestamps. Unknown operation/error values become OTHER and
UNRECOGNIZED; no raw-field search/count oracle or attempt-log claim is added.
Keep native created_at DESC/id ASC ordering and one-snapshot page/totals. DTO
millisecond projection must not reject valid native microsecond ordering.

Use READ COMMITTED READ ONLY operations with local statement/lock deadlines.
Recheck current credential-bound Internal Admin/session before and after data
SQL; enforce strict access expiry/cancellation before I/O and disclosure without
JWT clock tolerance. No writer locks or transaction/business-state changes.
Four actual async read slots remain occupied through disconnect until settlement;
bounded rate and SQL deadlines prevent abandoned work accumulating.

Selected JSON capability returns unavailable instead of simulating healthy empty
results or creating a new store. Monitoring is independent of ERP configuration,
production mode and all submission/retry/cancellation writers. Future operation
allowlist changes require explicit review; current unknown operations stay safe.

## Consequences and verification

No migration, dependency, provider traffic, UI or writer change is added. Search
is deliberately limited to ASCII identifier/code fragments and safe category
labels; raw payload debugging remains outside this API. Inspection reflects a
retained snapshot, not a complete attempt history or scheduler guarantee.

Verify real SQL statuses/projection/privacy/search/totals/detail, deadlines,
read-only enforcement, current proof/expiry after real waits, concurrent producer
updates, connection cleanup, JSON unavailable behavior and actual HTTP/runtime
composition. Real submission/retry-produced rows remain unchanged by inspection.
Record the observed failing-before/passing-after precision regression. This ADR
remains Proposed pending owner acceptance; it implies no merge or deployment.
