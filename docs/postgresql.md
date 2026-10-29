# PostgreSQL connection infrastructure

B2B-008 provides one lazy `pg.Pool` per API process, a read-only health probe, and
graceful shutdown. It does not implement migrations, SQL repository adapters, JSON
storage or startup provider selection. Business services must not import this
infrastructure directly. Future SQL adapters may receive the pool at composition.

## Configuration

Set `DATABASE_URL` through local or deployment secrets to a PostgreSQL URL with a
host and database. Both `postgres://` and `postgresql://` are accepted. Missing,
empty or whitespace-only URLs disable the pool; unrelated `PG_*` tuning settings
are then ignored. The Mock ERP does not consume this configuration.

| Setting                    | Default | Accepted range (inclusive) |
| -------------------------- | ------- | -------------------------- |
| `PG_POOL_MAX`              | 10      | 1–100 connections          |
| `PG_CONNECTION_TIMEOUT_MS` | 1000    | 1–60000 ms                 |
| `PG_IDLE_TIMEOUT_MS`       | 10000   | 1–600000 ms                |
| `PG_QUERY_TIMEOUT_MS`      | 5000    | 1–60000 ms                 |

When a URL is supplied, invalid settings fail startup with setting names/rules
only. An explicitly blank tuning value is invalid. Query timeout configures both
the driver read timeout and PostgreSQL `statement_timeout`. URL query parameters
`query_timeout`, `statement_timeout`, `connectionTimeoutMillis` and `options` are
rejected so they cannot override these bounds. TLS options in the connection URL
are passed to the driver; this code does not disable certificate verification.
Use `sslmode=verify-full` with an appropriate trust chain for remote databases.
Never commit real URLs, credentials, certificates or `.env` files.

## Health and failures

The pool starts empty. Each storage health check acquires a client, executes
`SELECT 1`, and releases it. Query failures and aborted probes discard that client;
an acquired client arriving after cancellation is immediately discarded. A pending
pool acquisition cannot be removed through pg's public API, but its configured
connection timeout bounds it. Idle-client errors are handled and logged only as
`postgres.pool_error`; no exception text, SQL, host or credentials are logged.
While a health probe owns a checked-out client it also handles that client's error
events, discarding broken connections instead of allowing unhandled socket errors.

The existing `/health` reporter bounds each dependency to 1000 ms. Deadline expiry
reports `timeout` and aborts the probe; connection/query failures report `down`.
Subsequent checks probe afresh. With no URL, storage is `unconfigured`.
The separate [ERP gateway](erp-gateway.md) must also be configured and available
for overall readiness to be 200; otherwise the API remains degraded/503.
`SELECT 1` does not establish schema, migration or repository readiness.

Runtime failures never switch to JSON, and this work does not select a persistence
provider at startup. That behavior belongs to B2B-012 after the JSON adapter exists.

## Shutdown

`SIGINT` and `SIGTERM` stop accepting HTTP connections, wait for in-flight responses,
then await `pool.end()`. Repeated signals share one promise, and each resource is
closed once. Listen failure also closes storage. `api.stopping`, `api.stopped` and
redacted `api.shutdown_failed` events record the outcome. Successful signals allow
natural exit with code 0; listen/cleanup failures produce code 1.

A 10-second deadline spans HTTP and pool draining. If exceeded, the API destroys
HTTP connections, attempts storage cleanup and forces exit code 1. This is a bound,
not a guarantee of completing work beyond the deadline. Windows process managers
must deliver a supported signal; forcibly terminating a process cannot run cleanup.

## Verification

Run `npm test --workspace=@b2b-portal/api` or root `npm run check`. Tests cover
configuration/redaction, client release and abort paths, idle errors, HTTP health,
stalled-handshake behavior with the real driver, HTTP draining, cleanup failures,
idempotence, deadlines and real entry-point signal handlers (via a cross-platform
test-only signal harness). No test-only endpoint is added to the application.

For real PostgreSQL verification, supply `B2B_TEST_DATABASE_URL` through the shell
to a disposable database and run the same tests. The optional integration test
checks backend connection reuse, health, query timeout and pool draining using
read-only queries; it makes no schema changes. Without that variable it explicitly
skips. Unit doubles and controlled TCP peers are not a substitute for this test.

Driver references: [pool lifecycle](https://node-postgres.com/apis/pool) and
[client timeouts](https://node-postgres.com/apis/client).
