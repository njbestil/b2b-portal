# ADR-023: Protected diagnostics for the selected runtime

- **Status:** Proposed
- **Related Issue:** njbestil/b2b-portal#87

## Context

Internal Admin needs selected storage, database health and ERP availability.
The public health endpoint reports readiness, but does not provide admin
admission or ERP identity. Selected JSON readiness is not PostgreSQL connectivity.
Startup deliberately retires an unreachable, unselected PostgreSQL pool.

## Options considered

1. Reuse the public health endpoint as admin diagnostics.
2. Reopen an unselected PostgreSQL pool for external database diagnostics.
3. Add a protected snapshot of selected-runtime readiness and bounded connectivity.

## Decision

Propose the third option. `GET /api/v1/admin/diagnostics` uses a dedicated
Internal Admin permission, fixed projection, no-store HTTP200 read result and
current session admission both before and after probes. Strict access expiry is
checked before probing and immediately before disclosure.

Reuse the selected runtime's existing readiness probe and, only for selected
PostgreSQL, its live `SELECT 1` health probe. Selected JSON reports database
`not_in_use` plus a configuration boolean, without asserting current external
PostgreSQL state or recreating its retired pool. ERP identity is the backend's
actual `mock` adapter or null. Keep public health behavior unchanged by extracting
its bounded checker into an application utility without altering its behavior.

## Consequences and risks

The snapshot distinguishes connectivity from schema/data readiness and exposes
no operational connection details or upstream payloads. One report per process
may have outstanding probes; timeout responses retain that slot until underlying
work settles, preventing accumulated abandoned operations. A source that never
settles therefore leaves diagnostics busy until normal process recovery.
Dependency observations are sampled concurrently and are not a transactional
promise that later business operations will succeed.

## Migration / verification

No migration, new dependency or environment setting. Verify real selected-SQL
connectivity with unavailable schema, JSON absent/fallback configuration and
retired-pool non-use, auth changes and exact expiry after waits, probe bounds,
redaction and existing public health regressions. Independent approval of this
proposal and implementation remains pending. See [API contract](../system-diagnostics-api.md).
