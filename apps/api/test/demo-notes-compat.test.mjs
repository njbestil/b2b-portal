import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { seedJson, seedPostgres } from "../dist/demo/seed.js";
import {
  loadMigrations,
  runMigrations,
} from "../dist/infrastructure/migrations.js";

test("confirmed JSON demo reset clears the known private-note extension, not unknown files", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "b2b-seed-notes-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "b2b_demo_notes"),
    options = { mode: "seed", confirmTarget: "b2b_demo_notes" };
  await seedJson(directory, options);
  await writeFile(
    join(directory, "order_internal_notes.json"),
    JSON.stringify([{ note: "private synthetic demo note" }]),
  );
  await seedJson(directory, { ...options, mode: "reset" });
  await assert.rejects(readFile(join(directory, "order_internal_notes.json")), {
    code: "ENOENT",
  });
  await writeFile(join(directory, "not_a_known_collection.json"), "keep");
  await assert.rejects(seedJson(directory, { ...options, mode: "reset" }));
  assert.equal(
    await readFile(join(directory, "not_a_known_collection.json"), "utf8"),
    "keep",
  );
});
test(
  "real PostgreSQL demo reset tolerates the known additive note table and still refuses unknown tables",
  {
    skip: process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL
      ? false
      : "Set B2B_TEST_MIGRATIONS_CLI_DATABASE_URL",
    timeout: 30000,
  },
  async (t) => {
    const url = new URL(process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL),
      admin = new Client({ connectionString: url.href });
    await admin.connect();
    const name = `b2b_demo_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    const client = new Client({ connectionString: url.href });
    await client.connect();
    t.after(async () => {
      try {
        await client.end();
        await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
    });
    await runMigrations(
      client,
      await loadMigrations(new URL("../migrations/", import.meta.url)),
    );
    const exists = (
      await client.query("SELECT to_regclass('order_internal_notes') AS name")
    ).rows[0].name;
    if (!exists) {
      // Test-only compatibility shape when the independent notes PR is not merged.
      // Combined-batch verification uses the real versioned 0002 migration instead.
      await client.query(
        "CREATE TABLE order_internal_notes(id uuid PRIMARY KEY,company_id uuid NOT NULL,order_id uuid NOT NULL,author_user_id uuid NOT NULL REFERENCES users(id),note text NOT NULL,created_at timestamptz NOT NULL,FOREIGN KEY(company_id,order_id) REFERENCES orders(company_id,id))",
      );
    }
    const options = { mode: "seed", confirmTarget: name };
    await seedPostgres(client, options);
    await client.query(
      "INSERT INTO order_internal_notes VALUES('d3e00000-0000-4000-8000-000000000999','d3e00000-0000-4000-8000-000000000001','d3e00000-0000-4000-8000-000000000201','d3e00000-0000-4000-8000-000000000010','Private synthetic demo note','2026-10-30T00:00:00Z')",
    );
    await seedPostgres(client, { ...options, mode: "reset" });
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM order_internal_notes",
        )
      ).rows[0].n,
      0,
    );
    await client.query("CREATE TABLE unrelated(value text)");
    await assert.rejects(seedPostgres(client, { ...options, mode: "reset" }));
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM companies")).rows[0]
        .n,
      2,
    );
  },
);
