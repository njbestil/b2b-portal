import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { createJsonInternalNotes } from "../dist/infrastructure/json/internal-notes.js";
import { createPostgresInternalNotes } from "../dist/infrastructure/postgres-internal-notes.js";
import {
  createInternalNotes,
  InternalNoteError,
} from "../dist/services/internal-notes.js";
import { JsonFileStore } from "../dist/infrastructure/json/store.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import {
  loadMigrations,
  runMigrations,
} from "../dist/infrastructure/migrations.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const admin = { id: id(10), role: "INTERNAL_ADMIN", status: "ACTIVE" };
const sales = { id: id(11), role: "SALES_STAFF", status: "ACTIVE" };
const scope = { companyId: id(1) },
  other = { companyId: id(2) },
  page = { offset: 0, limit: 100 };
const users = [
  { ...admin, companyId: null, displayName: "Admin" },
  { ...sales, companyId: null, displayName: "Sales" },
  {
    id: id(12),
    companyId: id(1),
    displayName: "Buyer",
    role: "CUSTOMER_USER",
    status: "ACTIVE",
  },
];
const orders = [1, 2].map((n) => ({
  id: id(20 + n),
  companyId: id(n),
  orderNumber: null,
  createdByUserId: admin.id,
  createdAt: "2026-10-30T00:00:00.000Z",
  status: "DRAFT",
  integrationStatus: "NOT_SENT",
}));
const row = (n, overrides = {}) => ({
  id: id(100 + n),
  companyId: id(1),
  orderId: id(21),
  authorUserId: admin.id,
  note: `Internal ${n}`,
  createdAt: "2026-10-30T00:00:00.000Z",
  ...overrides,
});
const code = (expected) => (error) =>
  error instanceof InternalNoteError && error.code === expected;
async function json(t) {
  const directory = await mkdtemp(join(tmpdir(), "b2b-notes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonFileStore(directory);
  await store.replace("users", users);
  await store.replace("orders", orders);
  return { directory, store, notes: createJsonInternalNotes(directory) };
}
test("customer/unknown/inactive identities are denied before authorization or repository I/O", async () => {
  let calls = 0;
  const access = createInternalNotes(
    {
      add() {
        calls++;
      },
      list() {
        calls++;
      },
    },
    async () => {
      calls++;
      return true;
    },
    randomUUID,
  );
  const sql = createPostgresInternalNotes({
    query() {
      calls++;
    },
  });
  for (const actor of [
    { ...admin, role: "CUSTOMER_ADMIN" },
    { ...admin, role: "CUSTOMER_USER" },
    { ...admin, role: "unknown" },
    { ...admin, status: "SUSPENDED" },
    null,
  ]) {
    await assert.rejects(
      access.add(actor, scope, id(21), "secret"),
      code("forbidden"),
    );
    await assert.rejects(access.list(actor, scope, id(21)), code("forbidden"));
    await assert.rejects(sql.add(actor, scope, row(1)), code("forbidden"));
    await assert.rejects(
      sql.list(actor, scope, id(21), page),
      code("forbidden"),
    );
  }
  assert.equal(calls, 0);
});
test("backend object/assignment authorization is mandatory and service owns author, identity and timestamp", async (t) => {
  const { notes } = await json(t);
  const denied = createInternalNotes(notes, async () => false, randomUUID);
  await assert.rejects(
    denied.add(sales, scope, id(21), "secret"),
    code("forbidden"),
  );
  const allowed = createInternalNotes(
    notes,
    async (actor, company) =>
      actor.id === sales.id && company.companyId === scope.companyId,
    randomUUID,
    () => new Date("2026-10-30T12:00:00.000Z"),
  );
  const note = await allowed.add(
    sales,
    scope,
    id(21),
    "  Plain internal text  ",
  );
  assert.equal(note.authorUserId, sales.id);
  assert.equal(note.createdAt, "2026-10-30T12:00:00.000Z");
  assert.equal(note.note, "Plain internal text");
  assert.match(note.id, /^[\da-f-]{36}$/);
  await assert.rejects(allowed.list(sales, other, id(22)), code("forbidden"));
});
test("JSON serializes append/reopen, detaches results, scopes pages and leaves customer orders note-free", async (t) => {
  const { notes, directory, store } = await json(t);
  assert.deepEqual(await notes.list(admin, scope, id(21), page), {
    total: 0,
    items: [],
  });
  await assert.rejects(readFile(join(directory, "order_internal_notes.json")), {
    code: "ENOENT",
  });
  await Promise.all(
    Array.from({ length: 12 }, (_, n) => notes.add(admin, scope, row(n))),
  );
  const listed = await createJsonInternalNotes(directory).list(
    admin,
    scope,
    id(21),
    { offset: 2, limit: 3 },
  );
  assert.equal(listed.total, 12);
  assert.deepEqual(
    listed.items.map((r) => r.id),
    [id(102), id(103), id(104)],
  );
  listed.items[0].note = "mutated";
  assert.equal(
    (await notes.list(admin, scope, id(21), { offset: 2, limit: 1 })).items[0]
      .note,
    "Internal 2",
  );
  assert.deepEqual(
    await notes.list(admin, scope, id(21), { offset: 50, limit: 5 }),
    { total: 12, items: [] },
  );
  assert.deepEqual(await notes.list(admin, other, id(22), page), {
    total: 0,
    items: [],
  });
  await assert.rejects(
    notes.list(admin, other, id(21), page),
    code("not_found"),
  );
  const customers = createJsonRepositories(store);
  assert.deepEqual(await customers.orders.findById(scope, id(21)), orders[0]);
  assert.ok(
    !JSON.stringify(await customers.orders.list(scope, page)).includes(
      "Internal",
    ),
  );
});
test("JSON references, author binding, validation and corruption fail safely without poisoning later writes", async (t) => {
  const { notes, directory, store } = await json(t);
  for (const note of ["", "   ", "x".repeat(4001), "bad\0text"])
    await assert.rejects(
      notes.add(admin, scope, row(1, { note })),
      code("invalid_note"),
    );
  await assert.rejects(
    notes.add(admin, scope, row(1, { authorUserId: sales.id })),
    code("forbidden"),
  );
  await assert.rejects(
    notes.add(admin, scope, row(1, { orderId: id(22) })),
    code("not_found"),
  );
  await assert.rejects(
    notes.add(admin, scope, row(1, { createdAt: "infinity" })),
    code("invalid_note"),
  );
  await notes.add(admin, scope, row(1));
  await assert.rejects(notes.add(admin, scope, row(1)), code("invalid_note"));
  await writeFile(join(directory, "order_internal_notes.json"), "DO_NOT_LEAK");
  await assert.rejects(
    notes.list(admin, scope, id(21), page),
    (error) =>
      error instanceof InternalNoteError &&
      !error.message.includes("DO_NOT_LEAK"),
  );
  await store.replace(
    "users",
    users.map((u) =>
      u.id === admin.id
        ? { ...u, role: "CUSTOMER_ADMIN", companyId: id(1) }
        : u,
    ),
  );
  await assert.rejects(
    notes.list(admin, scope, id(21), page),
    code("forbidden"),
  );
});
test("SQL adapter binds text and identifiers and redacts driver failures without JSON fallback", async () => {
  let values;
  const notes = createPostgresInternalNotes({
    async query(sql, args) {
      assert.ok(!sql.includes("private note DO_NOT_LEAK"));
      values = args;
      throw new Error("secret database DO_NOT_LEAK");
    },
  });
  await assert.rejects(
    notes.add(admin, scope, row(1, { note: "private note DO_NOT_LEAK" })),
    code("storage_failed"),
  );
  assert.ok(values.includes("private note DO_NOT_LEAK"));
  await assert.rejects(
    notes.list(admin, scope, id(21), { offset: -1, limit: 10 }),
    RangeError,
  );
});

const real = {
  skip: process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
    ? false
    : "Set B2B_TEST_MIGRATIONS_DATABASE_URL for isolated PostgreSQL schema",
  timeout: 30000,
};
async function database(t) {
  const connectionString = process.env.B2B_TEST_MIGRATIONS_DATABASE_URL;
  const adminClient = new Client({ connectionString });
  await adminClient.connect();
  const schema = `b2b_notes_${randomUUID().replaceAll("-", "")}`;
  await adminClient.query(`CREATE SCHEMA "${schema}"`);
  await adminClient.query(`SET search_path TO "${schema}"`);
  const migrations = await loadMigrations(
    new URL("../migrations/", import.meta.url),
  );
  await runMigrations(adminClient, migrations.slice(0, 1));
  for (const n of [1, 2])
    await adminClient.query(
      "INSERT INTO companies(id,legal_name,trade_name,status) VALUES($1,'Demo','Demo','ACTIVE')",
      [id(n)],
    );
  for (const u of users)
    await adminClient.query(
      "INSERT INTO users(id,company_id,display_name,role,status,email,password_hash) VALUES($1,$2,$3,$4,$5,$6,'disabled')",
      [
        u.id,
        u.companyId,
        u.displayName,
        u.role,
        u.status,
        `${u.id}@example.test`,
      ],
    );
  for (const o of orders)
    await adminClient.query(
      "INSERT INTO orders(id,company_id,created_by_user_id,created_at,order_status,integration_status) VALUES($1,$2,$3,$4,$5,$6)",
      [
        o.id,
        o.companyId,
        o.createdByUserId,
        o.createdAt,
        o.status,
        o.integrationStatus,
      ],
    );
  const pool = new Pool({
    connectionString,
    options: `-c search_path=${schema}`,
  });
  t.after(async () => {
    try {
      await pool.end();
      await adminClient.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await adminClient.end();
    }
  });
  assert.deepEqual(await runMigrations(adminClient, migrations), {
    applied: 1,
    skipped: 1,
  });
  assert.deepEqual(await runMigrations(adminClient, migrations), {
    applied: 0,
    skipped: 2,
  });
  return {
    client: adminClient,
    pool,
    notes: createPostgresInternalNotes(pool),
  };
}
test(
  "real PostgreSQL: additive migration preserves orders and enforces note FK/content/time constraints",
  real,
  async (t) => {
    const { client, notes } = await database(t);
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM orders")).rows[0].n,
      2,
    );
    const added = await notes.add(admin, scope, row(1));
    assert.deepEqual(added, row(1));
    const columns = (
      await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='order_internal_notes' ORDER BY ordinal_position",
      )
    ).rows.map((r) => r.column_name);
    assert.deepEqual(columns, [
      "id",
      "company_id",
      "order_id",
      "author_user_id",
      "note",
      "created_at",
    ]);
    for (const [company, order, author, note, time] of [
      [id(2), id(21), admin.id, "note", row(1).createdAt],
      [id(1), id(21), id(999), "note", row(1).createdAt],
      [id(1), id(21), admin.id, "  ", row(1).createdAt],
      [id(1), id(21), admin.id, "note", "infinity"],
    ]) {
      await assert.rejects(
        client.query(
          "INSERT INTO order_internal_notes(id,company_id,order_id,author_user_id,note,created_at) VALUES($1,$2,$3,$4,$5,$6)",
          [randomUUID(), company, order, author, note, time],
        ),
      );
    }
    await assert.rejects(
      notes.add(admin, scope, row(2, { orderId: id(22) })),
      code("not_found"),
    );
    await client.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [
      admin.id,
    ]);
    await assert.rejects(
      notes.list(admin, scope, id(21), page),
      code("forbidden"),
    );
    await assert.rejects(notes.add(admin, scope, row(2)), code("not_found"));
  },
);
test(
  "real PostgreSQL and JSON note append, paging and customer projections remain equivalent",
  real,
  async (t) => {
    const sql = await database(t),
      file = await json(t);
    for (let n = 0; n < 10; n++) {
      assert.deepEqual(
        await sql.notes.add(admin, scope, row(n)),
        await file.notes.add(admin, scope, row(n)),
      );
    }
    for (const p of [page, { offset: 2, limit: 3 }, { offset: 20, limit: 10 }])
      assert.deepEqual(
        await sql.notes.list(admin, scope, id(21), p),
        await file.notes.list(admin, scope, id(21), p),
      );
    const customerSql = createPostgresRepositories(sql.pool),
      customerJson = createJsonRepositories(file.store);
    assert.deepEqual(
      await customerSql.orders.findById(scope, id(21)),
      await customerJson.orders.findById(scope, id(21)),
    );
    assert.ok(
      !JSON.stringify(await customerSql.orders.list(scope, page)).includes(
        "Internal",
      ),
    );
    for (const actor of [
      { ...admin, role: "CUSTOMER_ADMIN" },
      { ...admin, role: "CUSTOMER_USER" },
    ]) {
      await assert.rejects(
        sql.notes.list(actor, scope, id(21), page),
        code("forbidden"),
      );
      await assert.rejects(
        file.notes.list(actor, scope, id(21), page),
        code("forbidden"),
      );
    }
  },
);
