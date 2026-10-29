# PostgreSQL migration runner

B2B-009 adds an explicit migration command and runner history, not the MVP
business schema. B2B-010 adds the [initial MVP schema](adr/001-mvp-postgresql-schema.md).
API startup, health, JSON storage and provider selection
are unchanged. There is no automatic migration, rollback/down or reset command.

## Run explicitly

Review the target database and SQL before running. Set `DATABASE_URL` using local
or deployment secrets, or in the untracked root `.env`. Then, from repository root:

```sh
npm run migrate --workspace=@b2b-portal/api
```

The command builds the API and reads `apps/api/migrations` relative to its built
entry point, not the current working directory. It uses existing PostgreSQL URL,
connection and statement-timeout validation. No API/Mock listener variables are
required. A missing database URL is an error, never JSON fallback or success.
No arbitrary path, reset or other CLI arguments are supported. Only the operator
should run this command, with appropriate DDL privileges and backups/approval for
the target environment. This issue does not authorize a production database change.

The CLI owns one dedicated `pg.Client`, sets `search_path` to `public`, and closes
the connection on success/failure. It does not use or alter the API's pool.
`PG_QUERY_TIMEOUT_MS` bounds each server statement (default 5000 ms), including
waiting for another runner. The CLI disables the separate driver read timeout so
it cannot return a driver timeout while a commit is still in flight; PostgreSQL's
statement timeout remains active. This is not a total batch/network deadline.
Connection loss during commit can leave an unknown outcome; reconnect and rerun
to reconcile history, rather than assuming failure means nothing committed.

Logs use `migrations.completed` with applied/skipped counts or
`migrations.failed` with a safe reason. Failures exit nonzero, without printing SQL,
database URLs, credentials, filenames, raw errors or stacks. A failed connection
close is also a failure. Inspect database diagnostics through an approved secure
operator channel if more detail is needed.

## Files, history and atomicity

Use positive four-digit versions and lowercase descriptive names, e.g.
`0001_initial.sql`. SQL must be trusted, reviewed UTF-8; see the
[authoring constraints](../apps/api/migrations/README.md). Files are sorted by
numeric version. Duplicate/invalid versions and empty SQL are rejected before
any database changes. The shipped `0001_mvp_schema.sql` creates the 17 approved core
tables and their constraints/indexes. A first successful run applies one version;
reruns skip it after verifying its checksum. It contains no seed or reset operations.

The runner begins one READ COMMITTED transaction on one connection, acquires a
transaction-scoped advisory lock **before** creating/reading `schema_migrations`,
and holds it through commit/rollback. Concurrent cooperating runners in the same
database serialize, even on the first run. The stable two-integer lock key is
`(747424, 9)`; this conservatively serializes separate schemas too. Other database
tools must not edit migration history or run this schema outside the runner.

`schema_migrations` records integer version (primary key), name, SHA-256 checksum
and a database-generated `applied_at` timestamp. Applied history must exactly match
a prefix of the available files. Changes, renames, removals and backfilled versions
are errors. Git enforces LF text checkouts; retain applied SQL text unchanged.
Pending SQL and history entries commit as one batch; failed transactional DDL/DML
and its history roll back together, while prior successful batches remain intact.
Nontransactional side effects cannot be undone by PostgreSQL rollback. Migration
authors must not issue transaction control or mutate history/search-path/lock state.

The reusable runner requires an otherwise idle connected `Client`; the caller
owns its lifecycle and fixed trusted search path. Never pass a pool or share the
connection with unrelated work. No new dependencies or application routes are added.

## Verification

Run `npm run check` or `npm test --workspace=@b2b-portal/api`. Unit protocol/state
doubles cover discovery/order, reruns/history drift, atomic query sequences,
failure cleanup and redacted CLI configuration/connection failures. Doubles are
not proof of real PostgreSQL rollback or concurrency.

For real database coverage, explicitly supply `B2B_TEST_MIGRATIONS_DATABASE_URL`
to a **disposable** PostgreSQL database, then run the same tests. This separate
opt-in is intentionally distinct from the existing read-only
`B2B_TEST_DATABASE_URL` pool test. The migration tests create randomly named
isolated schemas and drop only those schemas in cleanup; they do not use the
database's `public.schema_migrations` or application tables. The role needs schema
creation privileges. Tests verify DDL/history timestamps, repeat execution,
rollback after failed SQL, drift rejection and two concurrent clients. Without
this variable they are explicitly skipped. No production verification is implied.

The B2B-010 schema tests additionally exercise the shipped initial migration,
its constraints/indexes and exact numeric values under the same schema-only opt-in.
The actual CLI test has a **separate** `B2B_TEST_MIGRATIONS_CLI_DATABASE_URL` opt-in:
it creates/drops one uniquely named temporary database and requires `CREATEDB` on
that disposable test role. It does not migrate the supplied database's public
schema. The original opt-in does not acquire a new privilege requirement. Use a
disposable local test cluster/role, never production access.

References: [node-postgres transactions](https://node-postgres.com/features/transactions),
[PostgreSQL transactions](https://www.postgresql.org/docs/current/sql-begin.html),
[transaction-scoped advisory locks](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS).
