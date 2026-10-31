import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import {
  createNotifications,
  checkedNotification,
  NotificationError,
} from "../dist/services/notifications.js";
import { createJsonNotifications } from "../dist/infrastructure/json/notifications.js";
import { createPostgresNotifications } from "../dist/infrastructure/postgres-notifications.js";
import { selectStorage } from "../dist/infrastructure/storage.js";
import { JsonFileStore } from "../dist/infrastructure/json/store.js";
import { createDemoData, demoId } from "../dist/demo/dataset.js";
import { seedJson } from "../dist/demo/seed.js";
import {
  loadMigrations,
  runMigrations,
} from "../dist/infrastructure/migrations.js";
const at = "2026-10-31T12:00:00.000Z";
const input = (overrides = {}) => ({
  userId: demoId(31),
  type: "order.submitted",
  title: "Order submitted",
  message: "Your order was submitted.",
  ...overrides,
});
const record = (overrides = {}) => ({
  ...input(),
  id: randomUUID(),
  targetType: null,
  targetId: null,
  createdAt: at,
  readAt: null,
  ...overrides,
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "b2b-notifications-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonFileStore(directory),
    data = createDemoData();
  await store.replace("users", data.users);
  return { directory, notifications: createJsonNotifications(directory) };
}
const persisted = async (directory) =>
  JSON.parse(await readFile(join(directory, "notifications.json"), "utf8"));

test("service captures generated identity/time, optional target pair, unread state and detached input", async () => {
  let received;
  const service = createNotifications(
    {
      async append(row) {
        received = row;
        return row;
      },
    },
    () => demoId(999),
    () => new Date(at),
  );
  const source = input();
  const pending = service.create(source);
  source.title = "mutated";
  assert.deepEqual(await pending, record({ id: demoId(999) }));
  assert.equal(received.title, "Order submitted");
  const targeted = await service.create(
    input({ targetType: "order", targetId: demoId(201).toUpperCase() }),
  );
  assert.equal(targeted.targetId, demoId(201));
  const failed = createNotifications(
    {
      async append() {
        throw new NotificationError("storage_failed");
      },
    },
    randomUUID,
  );
  await assert.rejects(failed.create(input()), { code: "storage_failed" });
});

test("malformed and oversized content, unknown fields and spoofed generated fields fail before I/O", async () => {
  let calls = 0;
  const service = createNotifications(
    {
      async append(row) {
        calls++;
        return row;
      },
    },
    randomUUID,
  );
  for (const source of [
    null,
    [],
    input({ userId: "bad" }),
    input({ type: "" }),
    input({ type: "x".repeat(65) }),
    input({ title: " " }),
    input({ title: "x".repeat(201) }),
    input({ message: "x".repeat(2001) }),
    input({ message: "secret\0" }),
    input({ message: "unpaired\ud800" }),
    input({ targetType: "order" }),
    input({ targetId: demoId(201) }),
    input({ password: "DO_NOT_LEAK" }),
    input({ id: randomUUID() }),
    input({ companyId: demoId(2) }),
  ]) {
    await assert.rejects(
      service.create(source),
      (e) =>
        e instanceof NotificationError &&
        e.code === "invalid_record" &&
        !e.message.includes("DO_NOT_LEAK"),
    );
  }
  assert.equal(calls, 0);
  for (const changes of [
    { createdAt: "invalid" },
    { createdAt: "2026-01-01" },
    { readAt: at },
    { targetId: "bad", targetType: "order" },
  ])
    assert.throws(
      () => checkedNotification(record(changes)),
      NotificationError,
    );
  assert.equal(
    checkedNotification(
      record({ title: "x".repeat(200), message: "x".repeat(2000) }),
    ).message.length,
    2000,
  );
});

test("JSON serializes concurrent appends, keeps exact recipients/fields, detaches and reopens", async (t) => {
  const f = await fixture(t);
  const rows = Array.from({ length: 12 }, (_, i) =>
    record({
      userId: demoId(i % 2 ? 31 : 32),
      targetType: "order",
      targetId: demoId(201),
    }),
  );
  const pending = rows.map((row) => f.notifications.append(row));
  const original = structuredClone(rows);
  rows[0].title = "mutated before I/O";
  const results = await Promise.all(pending);
  results[0].title = "mutated result";
  assert.deepEqual(await persisted(f.directory), original);
  const next = record();
  await createJsonNotifications(f.directory).append(next);
  assert.deepEqual(await persisted(f.directory), [...original, next]);
  await assert.rejects(f.notifications.append(next), {
    code: "storage_failed",
  });
  await assert.rejects(
    f.notifications.append(record({ userId: demoId(999) })),
    { code: "storage_failed" },
  );
  assert.deepEqual(await persisted(f.directory), [...original, next]);
  assert.deepEqual((await readdir(f.directory)).sort(), [
    "notifications.json",
    "users.json",
  ]);
});

test("JSON corrupt state, failed publication and missing references are controlled and recoverable", async (t) => {
  const f = await fixture(t),
    path = join(f.directory, "notifications.json");
  for (const contents of ["DO_NOT_LEAK", "{}", '[{"id":"bad"}]']) {
    await writeFile(path, contents);
    await assert.rejects(
      f.notifications.append(record()),
      (e) => e.code === "storage_failed" && !e.message.includes("DO_NOT_LEAK"),
    );
    assert.equal(await readFile(path, "utf8"), contents);
  }
  const duplicate = record();
  await writeFile(path, JSON.stringify([duplicate, duplicate]));
  await assert.rejects(f.notifications.append(record()), {
    code: "storage_failed",
  });
  await rm(path);
  await mkdir(path);
  await assert.rejects(f.notifications.append(record()), {
    code: "storage_failed",
  });
  assert.deepEqual((await readdir(f.directory)).sort(), [
    "notifications.json",
    "users.json",
  ]);
  await rm(path, { recursive: true });
  await f.notifications.append(record());
  assert.equal((await persisted(f.directory)).length, 1);
  const missing = join(f.directory, "missing");
  await assert.rejects(createJsonNotifications(missing).append(record()), {
    code: "storage_failed",
  });
});

test("failed JSON write preserves published bytes, cleans temporary data and permits recovery", async (t) => {
  const f = await fixture(t);
  await f.notifications.append(record());
  const path = join(f.directory, "notifications.json");
  const before = await readFile(path, "utf8");
  const handle = await open(path, "r");
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const fault = t.mock.method(prototype, "writeFile", async () => {
    throw new Error("DO_NOT_LEAK_DISK");
  });
  try {
    await assert.rejects(
      f.notifications.append(record()),
      (e) => e.code === "storage_failed" && !e.message.includes("DO_NOT_LEAK"),
    );
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual((await readdir(f.directory)).sort(), [
      "notifications.json",
      "users.json",
    ]);
  } finally {
    fault.mock.restore();
  }
  await f.notifications.append(record());
  assert.equal((await persisted(f.directory)).length, 2);
});

test("explicit disposable demo reset clears only known private notification data", async (t) => {
  const f = await fixture(t),
    target = join(f.directory, "b2b_demo_notifications");
  const options = { mode: "seed", confirmTarget: "b2b_demo_notifications" };
  await seedJson(target, options);
  await createJsonNotifications(target).append(record());
  await writeFile(join(target, "unknown.json"), "keep");
  await assert.rejects(seedJson(target, { ...options, mode: "reset" }));
  assert.equal((await persisted(target)).length, 1);
  await rm(join(target, "unknown.json"));
  await seedJson(target, { ...options, mode: "reset" });
  await assert.rejects(readFile(join(target, "notifications.json")), {
    code: "ENOENT",
  });
  await createJsonNotifications(target).append(record());
});

test("SQL parameterizes exact fields, rejects malformed records before I/O and redacts errors", async () => {
  const row = record({ title: "A quote ' is data" }),
    calls = [];
  const sql = createPostgresNotifications({
    async query(query, values) {
      calls.push({ query, values });
      return { rows: [] };
    },
  });
  const result = await sql.append(row);
  assert.deepEqual(result, row);
  assert.notEqual(result, row);
  assert.ok(!calls[0].query.includes(row.title));
  assert.deepEqual(calls[0].values, [
    row.id,
    row.userId,
    row.type,
    row.title,
    row.message,
    null,
    null,
    at,
    null,
  ]);
  await assert.rejects(sql.append(record({ userId: "bad" })), {
    code: "invalid_record",
  });
  assert.equal(calls.length, 1);
  await assert.rejects(
    createPostgresNotifications({
      async query() {
        throw new Error("DO_NOT_LEAK_SQL");
      },
    }).append(row),
    (e) => e.code === "storage_failed" && !e.message.includes("DO_NOT_LEAK"),
  );
});

test("selected runtime exposes notification capability and never falls back after SQL failure", async (t) => {
  const f = await fixture(t);
  const settings = {
    jsonDirectory: f.directory,
    startupTimeoutMs: 100,
    logger: () => {},
  };
  const json = await selectStorage(settings);
  await json.notifications.append(record());
  await json.close();
  const before = await persisted(f.directory);
  const sql = await selectStorage({ ...settings, postgres: {} }, () => ({
    pool: {
      async query() {
        throw new Error("DO_NOT_LEAK");
      },
    },
    health: async () => true,
    probe: async () => false,
    close: async () => {},
  }));
  await assert.rejects(sql.notifications.append(record()), {
    code: "storage_failed",
  });
  assert.equal(sql.provider, "postgresql");
  assert.deepEqual(await persisted(f.directory), before);
  await sql.close();
});

test(
  "real PostgreSQL and JSON preserve identical notifications, recipient FKs and duplicate failures",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "Set B2B_TEST_MIGRATIONS_DATABASE_URL to a disposable database",
    timeout: 30000,
  },
  async (t) => {
    const connectionString = process.env.B2B_TEST_MIGRATIONS_DATABASE_URL;
    const client = new Client({ connectionString });
    await client.connect();
    const schema = `b2b_notifications_${randomUUID().replaceAll("-", "")}`;
    let pool;
    t.after(async () => {
      try {
        await pool?.end();
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await client.end();
      }
    });
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await runMigrations(
      client,
      await loadMigrations(new URL("../migrations/", import.meta.url)),
    );
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const f = await fixture(t);
    for (const n of [1, 2]) {
      await client.query(
        "INSERT INTO companies(id,legal_name,trade_name,status) VALUES($1,'Demo','Demo','ACTIVE')",
        [demoId(n)],
      );
      await client.query(
        "INSERT INTO users(id,company_id,email,password_hash,display_name,role,status) VALUES($1,$2,$3,'disabled','Demo','CUSTOMER_USER','ACTIVE')",
        [demoId(30 + n), demoId(n), `user${n}@example.test`],
      );
    }
    const sql = createPostgresNotifications(pool),
      rows = [
        record(),
        record({
          userId: demoId(32),
          targetType: "order",
          targetId: demoId(201),
          message: "تم تقديم الطلب — 🍎",
        }),
      ];
    for (const row of rows)
      assert.deepEqual(
        await sql.append(row),
        await f.notifications.append(row),
      );
    for (const repo of [sql, f.notifications]) {
      await assert.rejects(repo.append(rows[0]), { code: "storage_failed" });
      await assert.rejects(repo.append(record({ userId: demoId(999) })), {
        code: "storage_failed",
      });
      await assert.rejects(repo.append(record({ title: "" })), {
        code: "invalid_record",
      });
    }
    const stored = (
      await client.query(
        'SELECT id,user_id AS "userId",type,title,message,target_type AS "targetType",target_id AS "targetId",created_at AS "createdAt",read_at AS "readAt" FROM notifications ORDER BY id',
      )
    ).rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    assert.deepEqual(
      stored,
      (await persisted(f.directory)).sort((a, b) => a.id.localeCompare(b.id)),
    );
  },
);
