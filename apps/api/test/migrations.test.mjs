import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "pg";
import { parsePostgresEnvironment } from "@b2b-portal/config/server";
import {
  loadMigrations,
  runMigrations,
  MigrationError,
} from "../dist/infrastructure/migrations.js";

async function fixture(t, files = {}) {
  const directory = await mkdtemp(join(tmpdir(), "b2b-migrations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files))
    await writeFile(join(directory, name), content);
  return directory;
}
const one = { version: 1, name: "first", sql: "CREATE FIXTURE ONE" };
const two = { version: 2, name: "second", sql: "CREATE FIXTURE TWO" };
const digest = (sql) => createHash("sha256").update(sql).digest("hex");
const applied = (migration) => ({
  version: migration.version,
  name: migration.name,
  checksum: digest(migration.sql),
});
const errorCode = (code) => (error) =>
  error instanceof MigrationError &&
  error.code === code &&
  !error.message.includes("DO_NOT_LEAK");

// A protocol/state double, not evidence of PostgreSQL transactional semantics.
function database(history = []) {
  let committed = structuredClone(history);
  let working;
  let effects = [];
  let pendingEffects;
  const queries = [];
  const failures = new Set();
  const client = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (failures.has(sql)) throw new Error("DO_NOT_LEAK_SQL_OR_CREDENTIALS");
      if (sql.startsWith("BEGIN")) {
        working = structuredClone(committed);
        pendingEffects = [...effects];
      } else if (sql.startsWith("SELECT version"))
        return { rows: structuredClone(working) };
      else if (sql.startsWith("INSERT INTO schema_migrations"))
        working.push({
          version: values[0],
          name: values[1],
          checksum: values[2],
        });
      else if (sql === "COMMIT") {
        committed = working;
        effects = pendingEffects;
      } else if (sql === "ROLLBACK") {
        working = undefined;
        pendingEffects = undefined;
      } else if (
        !sql.startsWith("SELECT pg_advisory") &&
        !sql.startsWith("CREATE TABLE IF NOT EXISTS")
      )
        pendingEffects.push(sql);
      return { rows: [] };
    },
  };
  return {
    client,
    queries,
    failures,
    history: () => committed,
    effects: () => effects,
  };
}

test("migration loader sorts versioned SQL, ignores documentation and reads UTF-8", async (t) => {
  const directory = await fixture(t, {
    "0009_later.sql": "SELECT 'café';",
    "0001_first.sql": "SELECT 1;",
    "README.md": "not SQL",
  });
  assert.deepEqual(await loadMigrations(directory), [
    { version: 1, name: "first", sql: "SELECT 1;" },
    { version: 9, name: "later", sql: "SELECT 'café';" },
  ]);
  const empty = await fixture(t);
  assert.deepEqual(await loadMigrations(empty), []);
});

test("migration loader rejects invalid names, duplicate/zero versions, empty and invalid UTF-8 files", async (t) => {
  for (const files of [
    { "1_short.sql": "SELECT 1" },
    { "0001_Upper.sql": "SELECT 1" },
    { "0000_zero.sql": "SELECT 1" },
    { "0001_first.SQL": "SELECT 1" },
    { "0001_first.sql": "SELECT 1", "0001_again.sql": "SELECT 2" },
    { "0001_empty.sql": " \n" },
    { "0001_bad.sql": Buffer.from([0xff]) },
  ]) {
    await assert.rejects(loadMigrations(await fixture(t, files)));
  }
  const directory = await fixture(t);
  await mkdir(join(directory, "0001_directory.sql"));
  await assert.rejects(
    loadMigrations(directory),
    errorCode("invalid_migrations"),
  );
  await assert.rejects(loadMigrations(join(directory, "absent")), {
    code: "ENOENT",
  });
});

test("invalid in-memory migrations fail before any database query", async () => {
  for (const migrations of [
    [one, one],
    [{ ...one, version: 0 }],
    [{ ...one, version: 10000 }],
    [{ ...one, version: 1.5 }],
    [{ ...one, name: "DO_NOT_LEAK';" }],
    [{ ...one, sql: "" }],
  ]) {
    const f = database();
    await assert.rejects(
      runMigrations(f.client, migrations),
      errorCode("invalid_migrations"),
    );
    assert.deepEqual(f.queries, []);
  }
});

test("ordered migrations run once, record parameterized history and skip on rerun", async () => {
  const f = database();
  assert.deepEqual(await runMigrations(f.client, [two, one]), {
    applied: 2,
    skipped: 0,
  });
  assert.deepEqual(f.effects(), [one.sql, two.sql]);
  assert.deepEqual(f.history(), [applied(one), applied(two)]);
  assert.equal(f.queries[0].sql, "BEGIN ISOLATION LEVEL READ COMMITTED");
  assert.equal(f.queries[1].sql, "SELECT pg_advisory_xact_lock(747424, 9)");
  assert.match(
    f.queries[2].sql,
    /applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP/,
  );
  assert.equal(f.queries.at(-1).sql, "COMMIT");
  assert.deepEqual(await runMigrations(f.client, [one, two]), {
    applied: 0,
    skipped: 2,
  });
  assert.deepEqual(f.effects(), [one.sql, two.sql]);
  assert.equal(f.queries.filter((q) => q.sql === one.sql).length, 1);
});

test("an empty directory initializes history without inventing a business migration", async () => {
  const f = database();
  assert.deepEqual(await runMigrations(f.client, []), {
    applied: 0,
    skipped: 0,
  });
  assert.deepEqual(f.history(), []);
  assert.deepEqual(f.effects(), []);
});

test("later versions append while changed, renamed, removed and backfilled history fail closed", async () => {
  const f = database([applied(one)]);
  assert.deepEqual(await runMigrations(f.client, [one, two]), {
    applied: 1,
    skipped: 1,
  });
  for (const migrations of [
    [{ ...one, sql: one.sql + " " }, two],
    [{ ...one, name: "renamed" }, two],
    [two],
    [],
  ]) {
    const before = f.history();
    await assert.rejects(
      runMigrations(f.client, migrations),
      errorCode("history_mismatch"),
    );
    assert.equal(f.queries.at(-1).sql, "ROLLBACK");
    assert.deepEqual(f.history(), before);
  }
  const late = database([applied(two)]);
  await assert.rejects(
    runMigrations(late.client, [one, two]),
    errorCode("history_mismatch"),
  );
  assert.deepEqual(late.effects(), []);
});

test("history records with a wrong checksum/version cannot be silently skipped", async () => {
  for (const history of [
    [{ ...applied(one), checksum: "corrupt" }],
    [{ ...applied(one), version: 7 }],
  ]) {
    const f = database(history);
    await assert.rejects(
      runMigrations(f.client, [one]),
      errorCode("history_mismatch"),
    );
    assert.deepEqual(f.effects(), []);
  }
});

test("SQL and history-write failures roll back the entire pending batch and can be retried", async () => {
  for (const failSql of [
    two.sql,
    "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
    "COMMIT",
  ]) {
    const f = database();
    f.failures.add(failSql);
    await assert.rejects(
      runMigrations(f.client, [one, two]),
      errorCode("migration_failed"),
    );
    assert.equal(f.queries.at(-1).sql, "ROLLBACK");
    assert.deepEqual(f.history(), []);
    assert.deepEqual(f.effects(), []);
    f.failures.clear();
    assert.deepEqual(await runMigrations(f.client, [one, two]), {
      applied: 2,
      skipped: 0,
    });
  }
});

test("BEGIN, lock, history-query and rollback failures remain safe failures", async () => {
  for (const sql of [
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "SELECT pg_advisory_xact_lock(747424, 9)",
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  ]) {
    const f = database();
    f.failures.add(sql);
    await assert.rejects(
      runMigrations(f.client, [one]),
      errorCode("migration_failed"),
    );
    assert.deepEqual(f.effects(), []);
    assert.equal(
      f.queries.some((q) => q.sql === "ROLLBACK"),
      !sql.startsWith("BEGIN"),
    );
  }
  const f = database();
  f.failures.add(one.sql);
  f.failures.add("ROLLBACK");
  await assert.rejects(
    runMigrations(f.client, [one]),
    errorCode("migration_failed"),
  );
});

const entry = fileURLToPath(new URL("../dist/migrate.js", import.meta.url));
const env = (settings = {}) => ({
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...settings,
});

test("actual migration CLI requires only PostgreSQL configuration and redacts invalid inputs", () => {
  for (const settings of [
    {},
    { DATABASE_URL: "" },
    { DATABASE_URL: "DO_NOT_LEAK" },
    { DATABASE_URL: "postgresql://user:DO_NOT_LEAK@localhost/db?options=bad" },
    {
      DATABASE_URL: "postgresql://localhost/db",
      PG_QUERY_TIMEOUT_MS: "DO_NOT_LEAK",
    },
  ]) {
    const child = spawnSync(process.execPath, [entry], {
      env: env(settings),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    const record = JSON.parse(child.stderr);
    assert.equal(record.event, "migrations.failed");
    assert.equal(record.reason, "invalid_environment");
    assert.ok(!child.stderr.includes("DO_NOT_LEAK"));
  }
  const child = spawnSync(process.execPath, [entry, "--reset"], {
    env: env({ DATABASE_URL: "postgresql://localhost/db" }),
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stderr).reason, "migration_failed");
});

test(
  "actual migration CLI exits safely on refused/stalled PostgreSQL connections",
  { timeout: 10000 },
  async (t) => {
    for (const stall of [false, true]) {
      const sockets = new Set();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        if (!stall) socket.destroy();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(async () => {
        const closed = new Promise((resolve) => server.close(resolve));
        for (const socket of sockets) socket.destroy();
        await closed;
      });
      const child = spawn(process.execPath, [entry], {
        env: env({
          DATABASE_URL: `postgresql://demo:DO_NOT_LEAK@127.0.0.1:${server.address().port}/demo`,
          PG_CONNECTION_TIMEOUT_MS: "100",
        }),
        windowsHide: true,
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const closed = once(child, "close");
      t.after(() => {
        child.kill();
      });
      const [code] = await closed;
      assert.equal(code, 1);
      assert.equal(stdout, "");
      assert.equal(JSON.parse(stderr).reason, "migration_failed");
      assert.ok(!stderr.includes("DO_NOT_LEAK"));
    }
  },
);

// Separate opt-in: unlike the existing read-only pool test, this creates/drops
// ONLY a randomly named schema in an explicitly disposable test database.
async function postgresFixture(t) {
  const config = parsePostgresEnvironment({
    DATABASE_URL: process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
  });
  const admin = new Client({ ...config, query_timeout: 0 });
  await admin.connect();
  const schema = `b2b_migrations_${randomUUID().replaceAll("-", "")}`;
  const clients = [];
  t.after(async () => {
    try {
      for (const client of clients) await client.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const connect = async () => {
    const client = new Client({ ...config, query_timeout: 0 });
    clients.push(client);
    await client.connect();
    await client.query(`SET search_path TO "${schema}"`);
    return client;
  };
  return { connect };
}
const realOptions = {
  skip:
    !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
    "Set B2B_TEST_MIGRATIONS_DATABASE_URL to a disposable PostgreSQL database (creates/drops isolated schema)",
  timeout: 15000,
};

test(
  "real PostgreSQL: empty database, ordered DDL, history timestamps, rerun and failure rollback",
  realOptions,
  async (t) => {
    const { connect } = await postgresFixture(t);
    const client = await connect();
    const failed = [
      {
        version: 1,
        name: "fail",
        sql: "CREATE TABLE rollback_probe (id integer); SELECT definitely_not_a_function();",
      },
    ];
    await assert.rejects(
      runMigrations(client, failed),
      errorCode("migration_failed"),
    );
    assert.equal(
      (
        await client.query(
          "SELECT to_regclass('schema_migrations') AS history, to_regclass('rollback_probe') AS probe",
        )
      ).rows[0].history,
      null,
    );
    assert.equal(
      (await client.query("SELECT to_regclass('rollback_probe') AS probe"))
        .rows[0].probe,
      null,
    );
    const migrations = [
      {
        version: 1,
        name: "create_probe",
        sql: "CREATE TABLE migration_probe (id integer PRIMARY KEY);",
      },
      {
        version: 2,
        name: "insert_probe",
        sql: "INSERT INTO migration_probe VALUES (1);",
      },
    ];
    assert.deepEqual(await runMigrations(client, migrations.toReversed()), {
      applied: 2,
      skipped: 0,
    });
    assert.deepEqual(await runMigrations(client, migrations), {
      applied: 0,
      skipped: 2,
    });
    const history = (
      await client.query("SELECT * FROM schema_migrations ORDER BY version")
    ).rows;
    assert.deepEqual(
      history.map((r) => ({
        version: r.version,
        name: r.name,
        checksum: r.checksum,
      })),
      migrations.map(applied),
    );
    assert.ok(history.every((r) => r.applied_at instanceof Date));
    await assert.rejects(
      runMigrations(client, [
        { ...migrations[0], sql: "SELECT 1;" },
        migrations[1],
      ]),
      errorCode("history_mismatch"),
    );
    await assert.rejects(
      runMigrations(client, [
        ...migrations,
        {
          version: 3,
          name: "failed_append",
          sql: "INSERT INTO migration_probe VALUES (2); SELECT definitely_not_a_function();",
        },
      ]),
      errorCode("migration_failed"),
    );
    assert.deepEqual(
      (await client.query("SELECT id FROM migration_probe ORDER BY id")).rows,
      [{ id: 1 }],
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer AS n FROM schema_migrations",
        )
      ).rows[0].n,
      2,
    );
  },
);

test(
  "real PostgreSQL: concurrent runners serialize before first history-table creation",
  realOptions,
  async (t) => {
    const { connect } = await postgresFixture(t);
    const first = await connect(),
      second = await connect();
    const migrations = [
      {
        version: 1,
        name: "create_once",
        sql: "CREATE TABLE run_once (id integer PRIMARY KEY);",
      },
      {
        version: 2,
        name: "insert_once",
        sql: "SELECT pg_sleep(0.1); INSERT INTO run_once VALUES (1);",
      },
    ];
    const results = await Promise.all([
      runMigrations(first, migrations),
      runMigrations(second, migrations),
    ]);
    assert.deepEqual(
      results.sort((a, b) => b.applied - a.applied),
      [
        { applied: 2, skipped: 0 },
        { applied: 0, skipped: 2 },
      ],
    );
    assert.deepEqual((await first.query("SELECT * FROM run_once")).rows, [
      { id: 1 },
    ]);
    assert.equal(
      (
        await first.query(
          "SELECT count(*)::integer AS n FROM schema_migrations",
        )
      ).rows[0].n,
      2,
    );
  },
);
