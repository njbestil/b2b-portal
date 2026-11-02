import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { authFixture, barrier } from "./helpers/auth-fixture.mjs";
import { createJsonSalesAssignments } from "../dist/infrastructure/json/sales-assignments.js";
import { createPostgresSalesAssignments } from "../dist/infrastructure/postgres-sales-assignments.js";
import {
  createSalesScope,
  checkedAssignments,
} from "../dist/services/sales-assignments.js";
import { createScopedInternalNotes } from "../dist/services/scoped-internal-notes.js";
import { createJsonInternalNotes } from "../dist/infrastructure/json/internal-notes.js";
import { createPostgresInternalNotes } from "../dist/infrastructure/postgres-internal-notes.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createCompanyQueries } from "../dist/services/company-queries.js";
import { createOrderQueries } from "../dist/services/order-queries.js";
import { createAuthorization } from "../dist/services/authorization.js";
import { seedJson } from "../dist/demo/seed.js";
import { createJsonCatalogCache } from "../dist/infrastructure/json/catalog-cache.js";
import { selectStorage } from "../dist/infrastructure/storage.js";
const forbidden = (e) => e.name === "AuthorizationError",
  unavailable = (e) => e.code === "unavailable";
async function fixture(t, provider = "json") {
  const f = await authFixture(t, provider);
  for (let n = 0; n < f.data.users.length; n++)
    await f.setUser({ mustChangePassword: false }, n);
  const second = {
    ...f.data.users[1],
    id: randomUUID(),
    email: "second-sales@example.test",
    mustChangePassword: false,
  };
  f.data.users.push(second);
  f.second = f.data.users.length - 1;
  if (provider === "json")
    await f.security.run(async () => {
      const users = await f.security.store.read("users");
      await f.security.store.replace("users", [...users, second]);
    });
  else {
    await f.pool.query(
      "INSERT INTO users(id,email,password_hash,display_name,role,status,must_change_password) VALUES($1,$2,$3,$4,$5,$6,false)",
      [
        second.id,
        second.email,
        f.passwordHash,
        second.displayName,
        second.role,
        second.status,
      ],
    );
    for (const o of f.data.orders)
      await f.pool.query(
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
  }
  f.assignments =
    provider === "json"
      ? createJsonSalesAssignments(f.security, f.now)
      : createPostgresSalesAssignments(f.pool, f.now);
  f.scope = createSalesScope(f.assignments);
  f.actor = async (index) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(index)).accessToken,
      "profile.read",
    );
  f.assignment = (
    company = f.data.companies[0].id,
    staff = f.data.users[1].id,
    patch = {},
  ) => ({
    id: randomUUID(),
    companyId: company,
    salesStaffUserId: staff,
    assignedByUserId: f.data.users[0].id,
    isPrimary: true,
    active: true,
    createdAt: new Date(f.now() - 1000).toISOString(),
    endedAt: null,
    ...patch,
  });
  f.write = async (rows) => {
    if (provider === "json")
      await f.security.run(() =>
        fs.writeFile(
          join(f.directory, "customer_sales_assignments.json"),
          JSON.stringify(rows),
        ),
      );
    else {
      const c = await f.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("DELETE FROM customer_sales_assignments");
        for (const r of rows)
          await c.query(
            "INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              r.id,
              r.companyId,
              r.salesStaffUserId,
              r.assignedByUserId,
              r.isPrimary,
              r.active,
              r.createdAt,
              r.endedAt,
            ],
          );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
  };
  f.repositories =
    provider === "json"
      ? createJsonRepositories(f.security.store)
      : createPostgresRepositories(f.pool);
  f.notes = createScopedInternalNotes(
    provider === "json"
      ? createJsonInternalNotes(f.directory)
      : createPostgresInternalNotes(f.pool),
    f.assignments,
    randomUUID,
  );
  f.companyStatus = async (id, status) => {
    if (provider === "json")
      await f.security.run(async () => {
        const rows = await f.security.store.read("companies");
        await f.security.store.replace(
          "companies",
          rows.map((r) => (r.id === id ? { ...r, status } : r)),
        );
      });
    else
      await f.pool.query("UPDATE companies SET status=$1 WHERE id=$2", [
        status,
        id,
      ]);
  };
  return f;
}
test("logical assignment checks reject malformed, duplicate and contradictory evidence without choosing a winner", () => {
  const at = "2026-11-02T10:00:00.000Z",
    row = {
      id: randomUUID(),
      companyId: randomUUID(),
      salesStaffUserId: randomUUID(),
      assignedByUserId: randomUUID(),
      isPrimary: true,
      active: true,
      createdAt: at,
      endedAt: null,
    };
  assert.deepEqual(checkedAssignments([row]), [row]);
  for (const rows of [
    null,
    {},
    [row, row],
    [row, { ...row, id: randomUUID(), salesStaffUserId: randomUUID() }],
    [{ ...row, endedAt: at }],
    [{ ...row, role: "INTERNAL_ADMIN" }],
    [{ ...row, createdAt: "invalid" }],
    [{ ...row, active: false, endedAt: "2026-01-01T00:00:00.000Z" }],
  ])
    assert.throws(() => checkedAssignments(rows));
});
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
  };
  test(
    provider +
      ": two Sales/two-company current primary checks gate actual company/order reads and ignore historical authorship",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        [a, b] = f.data.companies,
        s1 = await f.actor(1),
        s2 = await f.actor(f.second);
      assert.equal(await f.assignments.ready(), true);
      await assert.rejects(f.scope(s1, a.id), forbidden);
      await f.write([
        f.assignment(a.id, s1.userId),
        f.assignment(b.id, s2.userId),
      ]);
      const scope = await f.scope(s1, a.id.toUpperCase());
      assert.equal(scope.companyId, a.id);
      assert.equal(Object.isFrozen(scope), true);
      const cq = createCompanyQueries(
          f.repositories.companies,
          f.repositories.users,
        ),
        oq = createOrderQueries(f.repositories.orders);
      assert.equal((await cq.getProfile(scope)).id, a.id);
      assert.equal((await oq.listOrders(scope)).total, 2);
      assert.equal(
        await oq.getOrder(
          scope,
          f.data.orders.find((o) => o.companyId === b.id).id,
        ),
        null,
      );
      await assert.rejects(f.scope(s1, b.id), forbidden);
      await assert.rejects(f.scope(s2, a.id), forbidden);
      for (const n of [0, 2, 3])
        await assert.rejects(f.scope(await f.actor(n), a.id), forbidden);
      await assert.rejects(f.scope({ ...s1 }, a.id), forbidden);
      const foreign = f.data.orders.find((o) => o.companyId === b.id);
      if (provider === "json")
        await f.security.store.replace(
          "orders",
          f.data.orders.map((o) =>
            o.id === foreign.id ? { ...o, createdByUserId: s1.userId } : o,
          ),
        );
      else
        await f.pool.query(
          "UPDATE orders SET created_by_user_id=$1 WHERE id=$2",
          [s1.userId, foreign.id],
        );
      await assert.rejects(f.scope(s1, b.id, "orders.read"), forbidden);
    },
  );
  test(
    provider +
      ": reassignment, deactivation, ended/non-primary/future and inactive-company evidence take effect on each operation",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        a = f.data.companies[0],
        s1 = await f.actor(1),
        s2 = await f.actor(f.second),
        row = f.assignment();
      await f.write([row]);
      await f.scope(s1, a.id);
      await f.write([
        { ...row, active: false, endedAt: new Date(f.now()).toISOString() },
        f.assignment(a.id, s2.userId),
      ]);
      await assert.rejects(f.scope(s1, a.id), forbidden);
      await f.scope(s2, a.id);
      await f.setUser({ status: "SUSPENDED" }, f.second);
      await assert.rejects(f.scope(s2, a.id), forbidden);
      await f.setUser({ status: "ACTIVE" }, f.second);
      await f.companyStatus(a.id, "SUSPENDED");
      await assert.rejects(f.scope(s2, a.id), forbidden);
      await f.companyStatus(a.id, "ACTIVE");
      for (const patch of [
        { active: false, endedAt: new Date(f.now()).toISOString() },
        { isPrimary: false },
        { createdAt: new Date(f.now() + 1000).toISOString() },
      ]) {
        await f.write([f.assignment(a.id, s1.userId, patch)]);
        await assert.rejects(f.scope(s1, a.id), forbidden);
      }
      await f.write([f.assignment(a.id, s1.userId)]);
      await f.setUser({ mustChangePassword: true }, 1);
      await assert.rejects(f.scope(s1, a.id), forbidden);
    },
  );
  test(
    provider +
      ": real internal-note bridge rechecks assignments, denies customers and preserves Admin historical visibility",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        [a, b] = f.data.companies,
        s1 = await f.actor(1),
        admin = await f.actor(0),
        customer = await f.actor(2),
        order = f.data.orders[0];
      await f.write([f.assignment(a.id, s1.userId)]);
      const note = await f.notes.add(
        s1,
        a.id,
        order.id,
        "Synthetic private note",
      );
      assert.equal(note.authorUserId, s1.userId);
      assert.equal((await f.notes.list(s1, a.id, order.id)).total, 1);
      await assert.rejects(
        f.notes.list(
          s1,
          b.id,
          f.data.orders.find((o) => o.companyId === b.id).id,
        ),
        forbidden,
      );
      await assert.rejects(f.notes.list(customer, a.id, order.id), forbidden);
      await assert.rejects(
        f.notes.add({ ...s1 }, a.id, order.id, "Forged"),
        forbidden,
      );
      await f.write([]);
      await assert.rejects(f.notes.list(s1, a.id, order.id), forbidden);
      await f.companyStatus(a.id, "SUSPENDED");
      assert.equal((await f.notes.list(admin, a.id, order.id)).total, 1);
      assert.equal(
        (
          await f.repositories.orders.list(
            { companyId: a.id },
            { offset: 0, limit: 20 },
          )
        ).total,
        2,
      );
    },
  );
  test(
    provider +
      ": corrupt duplicate evidence/provider failures never grant and do not change selected state",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        actor = await f.actor(1),
        a = f.data.companies[0];
      if (provider === "postgresql")
        await f.pool.query("DROP INDEX assignments_one_active_primary_idx");
      await f.write([
        f.assignment(),
        f.assignment(a.id, f.data.users[f.second].id),
      ]);
      await assert.rejects(f.scope(actor, a.id), unavailable);
      if (provider === "json") {
        await fs.writeFile(
          join(f.directory, "customer_sales_assignments.json"),
          "PRIVATE_CORRUPT",
        );
        assert.equal(await f.assignments.ready(), false);
      } else
        await f.pool.query(
          "ALTER TABLE customer_sales_assignments RENAME TO unavailable_assignments",
        );
      await assert.rejects(f.scope(actor, a.id), unavailable);
      assert.equal(await f.assignments.ready(), false);
    },
  );
}
test("JSON queued authority reads see reassignment published before admission, and missing/orphan evidence denies safely", async (t) => {
  const f = await fixture(t),
    actor = await f.actor(1),
    a = f.data.companies[0],
    entered = barrier(),
    release = barrier();
  await f.write([f.assignment()]);
  const held = f.security.run(async () => {
    entered.resolve();
    await release.promise;
    await fs.writeFile(
      join(f.directory, "customer_sales_assignments.json"),
      "[]",
    );
  });
  await entered.promise;
  const pending = f.scope(actor, a.id);
  release.resolve();
  await held;
  await assert.rejects(pending, forbidden);
  await fs.unlink(join(f.directory, "customer_sales_assignments.json"));
  await assert.rejects(f.scope(actor, a.id), forbidden);
  await f.write([f.assignment(a.id, randomUUID())]);
  await assert.rejects(f.scope(actor, a.id), unavailable);
});
test("offline cache preserves private assignment bytes and explicit demo reset clears known evidence while refusing unknown files", async (t) => {
  const parent = await fs.mkdtemp(
    join(process.env.TEMP ?? "/tmp", "b2b34-offline-"),
  );
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const name = "b2b_demo_assignments",
    dir = join(parent, name);
  await seedJson(dir, { mode: "seed", confirmTarget: name });
  const bytes = "[]\n";
  await fs.writeFile(join(dir, "customer_sales_assignments.json"), bytes);
  const cache = createJsonCatalogCache(dir, name, true);
  const products = JSON.parse(
    await fs.readFile(join(dir, "products.json"), "utf8"),
  );
  const access = JSON.parse(
    await fs.readFile(join(dir, "customer_product_access.json"), "utf8"),
  );
  const prices = JSON.parse(
    await fs.readFile(join(dir, "customer_product_prices.json"), "utf8"),
  );
  await cache.refresh(() => ({
    products,
    customer_product_access: access,
    customer_product_prices: prices,
  }));
  assert.equal(
    await fs.readFile(join(dir, "customer_sales_assignments.json"), "utf8"),
    bytes,
  );
  await seedJson(dir, { mode: "reset", confirmTarget: name });
  await assert.rejects(
    fs.readFile(join(dir, "customer_sales_assignments.json")),
    (e) => e.code === "ENOENT",
  );
  await fs.writeFile(join(dir, "unknown-private.json"), "[]");
  await assert.rejects(seedJson(dir, { mode: "reset", confirmTarget: name }));
});
test("selected runtime exposes current assignment policy and required readiness fails/recoveries without switching providers", async (t) => {
  const f = await fixture(t),
    actor = await f.actor(1),
    a = f.data.companies[0];
  await f.write([f.assignment()]);
  const runtime = await selectStorage({
    jsonDirectory: f.directory,
    startupTimeoutMs: 50,
    logger: () => {},
    requireSalesAssignments: true,
  });
  t.after(() => runtime.close());
  assert.equal(runtime.provider, "json");
  assert.equal(await runtime.salesAssignments.allows(actor.userId, a.id), true);
  assert.equal(await runtime.health(new AbortController().signal), true);
  const path = join(f.directory, "customer_sales_assignments.json"),
    bytes = await fs.readFile(path);
  await fs.writeFile(path, "PRIVATE_FAILURE");
  assert.equal(await runtime.health(new AbortController().signal), false);
  await assert.rejects(
    runtime.salesAssignments.allows(actor.userId, a.id),
    unavailable,
  );
  assert.equal(runtime.provider, "json");
  await fs.writeFile(path, bytes);
  assert.equal(await runtime.health(new AbortController().signal), true);
});
