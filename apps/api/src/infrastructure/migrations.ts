import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export class MigrationError extends Error {
  constructor(
    readonly code:
      "invalid_migrations" | "history_mismatch" | "migration_failed",
  ) {
    super(`Migration runner failed: ${code}`);
    this.name = "MigrationError";
  }
}

/** SQL is trusted, reviewed repository code, never supplied through an HTTP API. */
export async function loadMigrations(
  directory: string | URL,
): Promise<Migration[]> {
  const path = directory instanceof URL ? fileURLToPath(directory) : directory;
  const entries = await readdir(path, { withFileTypes: true });
  const migrations: Migration[] = [];
  for (const entry of entries) {
    if (!/\.sql$/i.test(entry.name)) continue;
    const match = /^(\d{4})_([a-z][a-z0-9_]*)\.sql$/.exec(entry.name);
    if (!entry.isFile() || !match)
      throw new MigrationError("invalid_migrations");
    const bytes = await readFile(join(path, entry.name));
    const sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    migrations.push({ version: Number(match[1]), name: match[2], sql });
  }
  return prepare(migrations);
}

function prepare(migrations: readonly Migration[]): Migration[] {
  const ordered = migrations
    .map(({ version, name, sql }) => ({ version, name, sql }))
    .sort((a, b) => a.version - b.version);
  for (const [index, migration] of ordered.entries()) {
    if (
      !Number.isInteger(migration.version) ||
      migration.version < 1 ||
      migration.version > 9999 ||
      !/^[a-z][a-z0-9_]*$/.test(migration.name) ||
      typeof migration.sql !== "string" ||
      !migration.sql.trim() ||
      ordered[index - 1]?.version === migration.version
    ) {
      throw new MigrationError("invalid_migrations");
    }
  }
  return ordered;
}

const checksum = (sql: string) =>
  createHash("sha256").update(sql).digest("hex");

/** Own an otherwise idle, connected Client for this call; never pass pool.query.
 * The caller owns connection errors/closing. All pending migrations form one batch.
 */
export async function runMigrations(
  client: Client,
  migrations: readonly Migration[],
) {
  const ordered = prepare(migrations);
  let began = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    began = true;
    // Same database-wide key for all runners, acquired before history-table DDL.
    await client.query("SELECT pg_advisory_xact_lock(747424, 9)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const history = await client.query<{
      version: number;
      name: string;
      checksum: string;
    }>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    // Applied history must be an exact prefix: no edits, deletions or backfills.
    for (const [index, applied] of history.rows.entries()) {
      const expected = ordered[index];
      if (
        !expected ||
        applied.version !== expected.version ||
        applied.name !== expected.name ||
        applied.checksum !== checksum(expected.sql)
      )
        throw new MigrationError("history_mismatch");
    }
    const pending = ordered.slice(history.rows.length);
    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        [migration.version, migration.name, checksum(migration.sql)],
      );
    }
    await client.query("COMMIT");
    return { applied: pending.length, skipped: history.rows.length };
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* Caller must close a broken session. */
      }
    }
    if (error instanceof MigrationError) throw error;
    // Database errors can include SQL, credentials or data: keep them out of CLI logs.
    throw new MigrationError("migration_failed");
  }
}
