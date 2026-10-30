import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import {
  createAudit,
  checkedAudit,
  AuditError,
} from "../dist/services/audit.js";
import { createJsonAudit } from "../dist/infrastructure/json/audit.js";
import { createPostgresAudit } from "../dist/infrastructure/postgres-audit.js";
import { JsonFileStore } from "../dist/infrastructure/json/store.js";
import { createDemoData, demoId } from "../dist/demo/dataset.js";
import { seedJson } from "../dist/demo/seed.js";
import {
  loadMigrations,
  runMigrations,
} from "../dist/infrastructure/migrations.js";
const at = "2026-10-30T12:00:00.000Z";
const record = (overrides = {}) => ({
  id: randomUUID(),
  companyId: null,
  actorUserId: null,
  actorRole: null,
  action: "login.failed",
  targetType: "user",
  targetId: null,
  metadata: { outcome: "denied", reasonCode: "INVALID_CREDENTIALS" },
  createdAt: at,
  ...overrides,
});
async function json(t) {
  const directory = await mkdtemp(join(tmpdir(), "b2b-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, audit: createJsonAudit(directory) };
}
test("audit service generates identity/time, snapshots allowed metadata and propagates append failures", async () => {
  let received;
  const input = record({ metadata: { changedFields: ["status"] } });
  delete input.id;
  delete input.createdAt;
  const audit = createAudit(
    {
      async append(row) {
        received = row;
        return row;
      },
    },
    () => demoId(999),
    () => new Date(at),
  );
  const pending = audit.record(input);
  input.metadata.changedFields.push("role");
  const result = await pending;
  assert.equal(result.id, demoId(999));
  assert.equal(result.createdAt, at);
  assert.deepEqual(received.metadata, { changedFields: ["status"] });
  const failed = createAudit(
    {
      async append() {
        throw new AuditError("storage_failed");
      },
    },
    randomUUID,
  );
  await assert.rejects(
    failed.record(input),
    (error) => error.code === "storage_failed",
  );
});
test("audit validation rejects credentials, arbitrary payloads, invalid roles/IDs and oversized metadata before I/O", () => {
  for (const metadata of [
    { password: "DO_NOT_LEAK" },
    { email: "private@example.test" },
    { token: "secret" },
    { details: { anything: "payload" } },
    { changedFields: ["password"] },
    { reasonCode: "x".repeat(65) },
    { requestId: "raw-input" },
  ])
    assert.throws(() => checkedAudit(record({ metadata })), AuditError);
  for (const overrides of [
    { actorUserId: demoId(10), actorRole: null },
    { actorRole: "unknown" },
    { actorUserId: demoId(31), actorRole: "CUSTOMER_USER" },
    { action: "DO_NOT_LEAK\n" },
    { createdAt: "infinity" },
  ])
    assert.throws(() => checkedAudit(record(overrides)), AuditError);
});
test("JSON audit appends serialize, reopen and remain detached; corruption/duplicates are safe failures", async (t) => {
  const { directory, audit } = await json(t),
    records = Array.from({ length: 12 }, () => record());
  const appended = await Promise.all(records.map((row) => audit.append(row)));
  appended[0].metadata.outcome = "mutated";
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "audit_logs.json"), "utf8")),
    records,
  );
  const next = record();
  await createJsonAudit(directory).append(next);
  await assert.rejects(
    audit.append(next),
    (error) => error.code === "storage_failed",
  );
  const before = await readFile(join(directory, "audit_logs.json"), "utf8");
  await assert.rejects(
    audit.append(
      record({ actorUserId: demoId(999), actorRole: "INTERNAL_ADMIN" }),
    ),
    (error) => error.code === "storage_failed",
  );
  assert.equal(
    await readFile(join(directory, "audit_logs.json"), "utf8"),
    before,
  );
  await writeFile(join(directory, "audit_logs.json"), "DO_NOT_LEAK");
  await assert.rejects(
    audit.append(record()),
    (error) =>
      error instanceof AuditError && !error.message.includes("DO_NOT_LEAK"),
  );
  assert.deepEqual(await readdir(directory), ["audit_logs.json"]);
});
test("JSON audit references match logical user/company foreign keys and demo reset explicitly clears owned audit data", async (t) => {
  const { directory, audit } = await json(t),
    store = new JsonFileStore(directory),
    data = createDemoData();
  await store.replace("companies", data.companies);
  await store.replace("users", data.users);
  await audit.append(
    record({
      companyId: demoId(1),
      actorUserId: demoId(31),
      actorRole: "CUSTOMER_USER",
      targetId: demoId(201),
    }),
  );
  const parent = await mkdtemp(join(tmpdir(), "b2b-audit-reset-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = join(parent, "b2b_demo_audit");
  await seedJson(target, { mode: "seed", confirmTarget: "b2b_demo_audit" });
  await createJsonAudit(target).append(record());
  await seedJson(target, { mode: "reset", confirmTarget: "b2b_demo_audit" });
  await assert.rejects(readFile(join(target, "audit_logs.json")), {
    code: "ENOENT",
  });
});
test("PostgreSQL audit parameterizes data, rejects invalid metadata before query and redacts failures", async () => {
  let calls = 0,
    args;
  const audit = createPostgresAudit({
    async query(sql, values) {
      calls++;
      args = values;
      assert.ok(!sql.includes("login.failed"));
      throw new Error("DO_NOT_LEAK_DATABASE");
    },
  });
  await assert.rejects(
    audit.append(record()),
    (error) =>
      error.code === "storage_failed" && !error.message.includes("DO_NOT_LEAK"),
  );
  assert.equal(args[4], "login.failed");
  await assert.rejects(
    audit.append(record({ metadata: { password: "DO_NOT_LEAK" } })),
    AuditError,
  );
  assert.equal(calls, 1);
});
test(
  "real PostgreSQL/JSON audit persistence has identical actor/action/target/time/metadata and FK failure behavior",
  {
    skip: process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
      ? false
      : "Set B2B_TEST_MIGRATIONS_DATABASE_URL",
    timeout: 30000,
  },
  async (t) => {
    const client = new Client({
      connectionString: process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
    });
    await client.connect();
    const schema = `b2b_audit_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await runMigrations(
      client,
      await loadMigrations(new URL("../migrations/", import.meta.url)),
    );
    const pool = new Pool({
      connectionString: process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    t.after(async () => {
      try {
        await pool.end();
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await client.end();
      }
    });
    const file = await json(t),
      store = new JsonFileStore(file.directory),
      data = createDemoData();
    await store.replace("companies", data.companies);
    await store.replace("users", data.users);
    await client.query(
      "INSERT INTO companies(id,legal_name,trade_name,status) VALUES($1,'Demo','Demo','ACTIVE')",
      [demoId(1)],
    );
    await client.query(
      "INSERT INTO users(id,company_id,email,password_hash,display_name,role,status) VALUES($1,$2,'demo@example.test','disabled','Demo','CUSTOMER_USER','ACTIVE')",
      [demoId(31), demoId(1)],
    );
    const sql = createPostgresAudit(pool),
      rows = [
        record(),
        record({
          companyId: demoId(1),
          actorUserId: demoId(31),
          actorRole: "CUSTOMER_USER",
          action: "order.created",
          targetType: "order",
          targetId: demoId(201),
          metadata: {
            orderId: demoId(201),
            requestId: demoId(998),
            outcome: "success",
          },
        }),
      ];
    for (const row of rows) {
      assert.deepEqual(await sql.append(row), await file.audit.append(row));
    }
    const persisted = (
      await client.query(
        'SELECT id,company_id AS "companyId",actor_user_id AS "actorUserId",actor_role AS "actorRole",action,target_type AS "targetType",target_id AS "targetId",metadata,created_at AS "createdAt" FROM audit_logs ORDER BY created_at,id',
      )
    ).rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    assert.deepEqual(
      persisted,
      [...rows].sort((a, b) => a.id.localeCompare(b.id)),
    );
    for (const audit of [sql, file.audit])
      await assert.rejects(
        audit.append(record({ companyId: demoId(999) })),
        (error) => error.code === "storage_failed",
      );
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0]
        .n,
      2,
    );
  },
);
