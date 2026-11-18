# Internal Admin system diagnostics (#87)

`GET /api/v1/admin/diagnostics` requires a normal authenticated Internal Admin
and the dedicated `diagnostics.read` permission. It accepts no query parameters,
provider selectors, URLs or caller authority. Other roles are denied before any
probe starts. All responses use the standard no-store envelope.

A successful diagnostics read returns HTTP 200, including degraded dependencies:

```json
{
  "storage": { "provider": "json", "status": "up" },
  "database": {
    "provider": "postgresql",
    "configured": true,
    "status": "not_in_use"
  },
  "erp": { "provider": "mock", "status": "down" }
}
```

Only these fields are returned. Storage provider is `postgresql` or `json`.
Storage and ERP status are `up`, `down`, `timeout` or `unconfigured`. ERP provider
is `mock` when the backend configured the existing Mock ERP adapter; otherwise
it is null and availability is `unconfigured`. Provider identity is never inferred
from a client header, URL or upstream response body.

## Storage readiness and database connectivity

Storage status uses the selected runtime's existing readiness probe. PostgreSQL
readiness checks the required schema and configured authentication stores. JSON
readiness checks the selected collection/authentication files. A failed probe
never changes the selected provider or reads another provider's business data.

When PostgreSQL is selected, database status is `up`, `down` or `timeout`, from
the existing live `SELECT 1` probe on that same pool. Connectivity can be up while
storage readiness is down, for example when a required table is unavailable.
Connectivity alone does not establish schema readiness, ERP availability or
whether a business operation will succeed.

When JSON is selected, database status is `not_in_use`. `configured: false`
means no PostgreSQL configuration was supplied; `configured: true` means a
PostgreSQL configuration existed but startup selected JSON after the bounded
reachability check. Neither case claims that an unused external database is
currently up, down or recovered. The retired pool is never reopened or replaced
for diagnostics. Configuration is reported as a boolean only.

## Bounds and authorization ordering

Storage, selected-database and ERP probes run concurrently with a fixed 1000 ms
per-probe deadline. The shared bounded health checker maps only literal true to
`up`, contains thrown/rejected errors, aborts on timeout and clears its timer.
No retries, migrations, resets, provider switching or business writes occur.
The existing ERP adapter retains its request/body bounds and cancellation.

Only one admin diagnostics report may have outstanding probes per API process.
A concurrent request returns 503 `DIAGNOSTICS_BUSY`. After a timeout, a source
that ignores cancellation retains the slot until its actual work settles; more
requests cannot accumulate abandoned probe operations. A permanently stuck
source consequently keeps diagnostics busy until it settles or the process is
restarted through normal operations. There is no request-driven reset control.

The API checks the runtime capability and strict access expiry before probes.
After probe waits, it re-admits the Bearer token against current backend state
and checks strict expiry again immediately before disclosure. Revoked sessions,
changed credentials/role/status, first-login restrictions and access expiry
cannot borrow the JWT verifier's clock tolerance to expose a completed report.
Already completed reads may finish; no account/session lock is held across
network probes.

Unknown/repeated/nested query keys return 400 `INVALID_DIAGNOSTICS_QUERY` without
probing. Missing service/configuration returns controlled 503
`DIAGNOSTICS_UNAVAILABLE`; standard 401/403/503 session admission errors remain.
Dependency failures are safe diagnostic data, not raw exception responses.
Connection strings, hosts, paths, credentials, tokens, upstream bodies and error
stacks are excluded from reports and diagnostics logging.

The public `/health` response and its readiness HTTP 200/503 semantics remain
unchanged. #88 owns the composed admin diagnostics screen. No migration,
dependency, environment setting or ERP ownership change is required.

## Verification

`apps/api/test/diagnostics.test.mjs` covers both-provider HTTP role admission and
post-wait authority/strict expiry, stable allowlists, bounded probes/concurrency,
JSON absent/fallback selection without retired-pool reuse, real PostgreSQL
connectivity versus schema readiness, and real HTTP ERP adapter availability.
Existing authorization, health, storage-selection and ERP suites verify reused
behavior. SQL opt-ins must point only to disposable synthetic infrastructure.
