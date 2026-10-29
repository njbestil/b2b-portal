# ADR-002: Startup-only storage-provider selection

- Status: Proposed — implementation review pending
- Related Issue: [B2B-012 / #24](https://github.com/njbestil/b2b-portal/issues/24)

## Context and options

Requirements 3.3/3.9 already approve PostgreSQL when configured and reachable,
otherwise JSON for the whole process. They explicitly forbid silently redirecting
writes after a runtime failure. B2B-008 supplies the pool, B2B-011 JSON read adapters,
and B2B-010 the SQL schema. Merely exposing a PostgreSQL label while retaining JSON
repositories would not implement that policy. Dynamic per-request fallback and a
manual force-provider flag were rejected as inconsistent with the approved rules.

## Decision

API startup parses all configuration before constructing storage. `selectStorage`
performs at most one bounded `SELECT 1` reachability probe. Success composes one
PostgreSQL runtime; absence, failure or deadline expiry composes one JSON runtime.
The selected `provider` is frozen and there is no reselection path. Neither health
checks, repository errors nor later PostgreSQL recovery change the choice. A later
process restart may choose a different provider.

The runtime contains the current company/user/catalog/order read ports, a selected-
provider health probe and one cleanup owner. The minimal PostgreSQL adapters
implement those existing seven methods with parameterized, company-scoped SQL,
known-field projections and exact NUMERIC text. Pages return items/count from one
SQL statement/snapshot, including beyond-end pages. Customer-price windows and
default-price fallback match the JSON read implementation. No new business write
port, route, catalog sync, PostgreSQL CRUD suite or full-entity JSON model is added.
Future features must extend the same selected runtime, not construct fallback
repositories independently or catch database write errors and redirect them.

After an unsuccessful startup probe, pool retirement starts immediately. Late pg
acquisition/cleanup does not delay JSON listener startup; its one cleanup promise
is still owned by shutdown. Errors are handled and logged as
`storage.cleanup_failed`, without raw exceptions. The existing bounded shutdown
waits for retired/active storage after HTTP draining; it fails safely if cleanup
cannot finish. There is no database write or migration during selection.

## Configuration and operation

| Setting                      | Default                 | Meaning                                                                                |
| ---------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`               | absent/blank            | Missing selects JSON; supplied URL/tuning must pass existing PostgreSQL validation     |
| `JSON_DATA_DIR`              | `apps/api/data/runtime` | Trusted backend directory; relative paths resolve from the API package, not launch CWD |
| `STORAGE_STARTUP_TIMEOUT_MS` | `1000`                  | Integer 1–60000 ms, total startup reachability deadline                                |

Empty `JSON_DATA_DIR` uses the default. Surrounding whitespace/control characters
in a supplied path are invalid. Invalid configuration fails startup with setting
names/rules only; it is not treated as an unreachable database. No credentials,
paths or upstream exception messages are returned/logged. Existing pg connection
and query bounds still govern pending/retiring I/O.

JSON must be explicitly populated with the six existing entity/cache files; see
[JSON storage](../json-storage.md). Startup does not create empty collections or
silently seed/reset data. B2B-013 owns reproducible demo seed/reset. Missing or
corrupt files do not prevent the listener from starting in JSON mode, but storage
readiness is **down**, not a fake empty database. Hosted JSON remains disposable
demo/setup state on an ephemeral filesystem, never durable production fallback.

## Health, failures and boundaries

`/health` includes `storage.provider: "postgresql" | "json"` in both success and
degraded envelopes. This additive optional field leaves generic app/probe consumers
compatible; the real API startup always sets it. The same provider is reported
in `storage.selected` and `api.started` logs. No new public diagnostics route or
authentication/tenant boundary is introduced.

PostgreSQL readiness checks that all columns/tables needed by the current read
ports can be selected with `LIMIT 0`, without fetching customer/commercial records.
A reachable database without that schema stays PostgreSQL-selected but reports
down. Apply migrations explicitly through the existing command; do not repair or
fallback silently. This is not a full check of all future workflow tables or data.
JSON readiness reads/validates all six collections on every check. Both probes
remain subject to the health reporter's 1000 ms deadline; a JSON file read may
settle after cancellation, but cannot mutate data or trigger reselection.

Overall health still requires ERP to be up. A healthy selected store alone does
not make the API ready when ERP is unconfigured/unavailable. Business repository
errors propagate as controlled failures; PostgreSQL adapters redact driver errors.
Actual authorization still belongs in backend callers before scoped queries.

## Verification and consequences

Run `npm run check`. `storage-selection.test.mjs` covers missing/refused/stalled/
throwing PostgreSQL, immutable selection, late/failed retirement, redaction,
configuration, JSON corruption, HTTP/HEAD diagnostics and real entry-point startup.
With the existing `B2B_TEST_MIGRATIONS_DATABASE_URL` schema-only opt-in, real SQL
reads are compared against JSON across all current ports, pricing boundaries,
tenant filters, exact decimals and pagination. Real schema loss must remain on
PostgreSQL and recover without switching.

The separate `B2B_TEST_MIGRATIONS_CLI_DATABASE_URL` opt-in permits an isolated
temporary database for real-process missing-schema/migrated-schema/recovery tests.
It requires `CREATEDB` only on that disposable test role; normal schema-only tests
do not gain new permissions. No system service, new repository dependency,
production connection, seed/reset or deployment is required by this issue.
