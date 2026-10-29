# PostgreSQL migration files

B2B-009 provides the runner and its `schema_migrations` history table only.
B2B-010 supplies `0001_mvp_schema.sql` for the 17 approved core entities. See the
[physical mapping ADR](../../../docs/adr/001-mvp-postgresql-schema.md) for constraints,
indexes, service-owned invariants and scope exclusions. There is no seed/reset SQL.

Add reviewed UTF-8 files named `0001_description.sql`, `0002_description.sql`,
and so on. Versions must be positive, unique four-digit numbers. Gaps are allowed;
new files must sort after all applied versions. Names use lowercase letters,
digits and underscores, beginning with a letter. Non-SQL documentation is ignored;
invalid SQL filenames, symlinks, directories ending in `.sql` and empty files fail.

SQL runs inside the runner's transaction. Do not include `BEGIN`, `COMMIT`,
`ROLLBACK`, operations forbidden in transactions (e.g. `CREATE INDEX CONCURRENTLY`),
or statements that change the search path/history table/advisory lock. These are
trusted migration-authoring constraints, not a SQL sandbox or parser. Review SQL
before use; never accept migration files from HTTP callers. Avoid external side
effects and PostgreSQL operations with nontransactional effects such as sequences
when designing rollback guarantees.

Applied files are immutable, including line endings: SHA-256 checksums cover their
SQL text. Never edit, rename, remove or insert before an applied migration; add a
new migration instead. Deployments must retain the full migration history.

See [the migration runbook](../../../docs/migrations.md) for the explicit command,
transaction, concurrency and testing behavior. Nothing runs during API startup.
