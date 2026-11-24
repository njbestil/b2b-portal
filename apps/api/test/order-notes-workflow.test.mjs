import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createOrderNotes } from "../dist/services/order-notes.js";
import { createPostgresOrderNotes } from "../dist/infrastructure/postgres-order-notes.js";
import { createJsonOrderNotes } from "../dist/infrastructure/json/order-notes.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createApp } from "../dist/app.js";
for (const provider of ["json", "postgresql"]) {
  const opts = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "PostgreSQL required"
        : false,
  };
  async function setup(t) {
    const f = await authFixture(t, provider);
    for (let i = 0; i < f.data.users.length; i++)
      await f.setUser({ mustChangePassword: false }, i);
    f.company = f.data.companies[0].id;
    f.order = f.data.orders[0].id;
    if (provider === "postgresql")
      for (const o of f.data.orders)
        await f.pool.query(
          "INSERT INTO orders(id,company_id,created_by_user_id,order_number,order_status,integration_status) VALUES($1,$2,$3,$4,$5,$6)",
          [
            o.id,
            o.companyId,
            o.createdByUserId,
            o.orderNumber,
            o.status,
            o.integrationStatus,
          ],
        );
    const a = {
      id: randomUUID(),
      companyId: f.company,
      salesStaffUserId: f.data.users[1].id,
      assignedByUserId: f.data.users[0].id,
      isPrimary: true,
      active: true,
      createdAt: new Date(f.now() - 1000).toISOString(),
      endedAt: null,
    };
    f.assign = async (active) => {
      if (provider === "json")
        await f.security.run(() =>
          writeFile(
            join(f.directory, "customer_sales_assignments.json"),
            JSON.stringify(active ? [a] : []),
          ),
        );
      else if (active)
        await f.pool.query(
          "INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at) VALUES($1,$2,$3,$4,true,true,$5)",
          [
            a.id,
            a.companyId,
            a.salesStaffUserId,
            a.assignedByUserId,
            a.createdAt,
          ],
        );
      else
        await f.pool.query(
          "DELETE FROM customer_sales_assignments WHERE id=$1",
          [a.id],
        );
    };
    await f.assign(true);
    f.repo =
      provider === "json"
        ? createJsonOrderNotes(f.security, f.now)
        : createPostgresOrderNotes(f.pool, f.now);
    f.events = [];
    f.service = createOrderNotes(
      f.repo,
      async (e) => {
        f.events.push(e);
        return f.record(e);
      },
      randomUUID,
    );
    f.actor = async (i = 1) =>
      createAuthorization(f.auth.authenticateAccess).admit(
        (await f.login(i)).accessToken,
        "orders.read",
      );
    f.sales = await f.actor();
    f.page = (actor = f.sales, offset = 0, limit = 20) =>
      f.service.list(actor, f.company, f.order, { offset, limit });
    return f;
  }
  test(
    `${provider}: assigned Sales appends private server-authored notes with detached stable paging`,
    opts,
    async (t) => {
      const f = await setup(t),
        notes = await Promise.all(
          Array.from({ length: 4 }, (_, n) =>
            f.service.add(
              f.sales,
              f.company,
              f.order,
              { note: " PRIVATE_SYNTHETIC_NOTE_" + n + " " },
              randomUUID(),
            ),
          ),
        );
      assert.equal(new Set(notes.map((r) => r.note.id)).size, 4);
      assert.ok(
        notes.every(
          (r) =>
            r.note.authorUserId === f.data.users[1].id &&
            r.note.companyId === f.company &&
            r.note.note.startsWith("PRIVATE"),
        ),
      );
      const page = await f.page(f.sales, 1, 2);
      assert.equal(page.total, 4);
      assert.equal(page.items.length, 2);
      page.items[0].note = "MUTATED";
      assert.ok(
        (await f.page()).items.every((r) => r.note.startsWith("PRIVATE")),
      );
      assert.ok(
        f.events.every(
          (e) =>
            e.action === "order.internal_note_added" &&
            !JSON.stringify(e).includes("PRIVATE"),
        ),
      );
      const admin = await f.actor(0);
      await f.service.add(
        admin,
        f.company,
        f.order,
        { note: "Admin context" },
        randomUUID(),
      );
      assert.equal((await f.page(admin)).total, 5);
    },
  );
  test(
    `${provider}: customer/foreign scope/reassignment/stale proofs and invalid note input deny safely`,
    opts,
    async (t) => {
      const f = await setup(t),
        a = f.sales,
        s = f.service;
      for (const actor of [await f.actor(2), await f.actor(3), { ...a }])
        await assert.rejects(
          f.page(actor),
          (e) => e.name === "AuthorizationError",
        );
      for (const note of ["", "x".repeat(4001), "x\0y"])
        await assert.rejects(
          s.add(a, f.company, f.order, { note }, randomUUID()),
          { code: "invalid_note" },
        );
      await assert.rejects(
        s.add(
          a,
          f.company,
          f.order,
          { note: "x", authorUserId: f.data.users[0].id },
          randomUUID(),
        ),
        { code: "invalid_note" },
      );
      await assert.rejects(
        s.list(a, f.data.companies[1].id, f.order, { offset: 0, limit: 20 }),
        { code: "forbidden" },
      );
      await assert.rejects(
        s.list(a, f.company, randomUUID(), { offset: 0, limit: 20 }),
        { code: "not_found" },
      );
      await f.assign(false);
      await assert.rejects(
        s.add(a, f.company, f.order, { note: "Denied" }, randomUUID()),
        { code: "forbidden" },
      );
      await f.assign(true);
      await f.setUser({ status: "SUSPENDED" }, 1);
      await assert.rejects(f.page(), { code: "invalid_proof" });
    },
  );
  test(
    `${provider}: expired access at the provider boundary cannot append a note`,
    opts,
    async (t) => {
      const f = await setup(t),
        expired = f.sales;
      f.clock.value = Date.parse(expired.accessExpiresAt) + 1;
      await assert.rejects(
        f.service.add(
          expired,
          f.company,
          f.order,
          { note: "Must not be stored" },
          randomUUID(),
        ),
        { code: "invalid_proof" },
      );
      f.clock.value -= 60000;
      assert.equal((await f.page(await f.actor(0))).total, 0);
    },
  );
  test(
    `${provider}: real HTTP keeps notes out of customer projections and returns safe no-store errors`,
    opts,
    async (t) => {
      const f = await setup(t),
        server = createApp({
          sessions: f.auth,
          orderNotes: f.service,
          companyRepositories:
            provider === "json"
              ? createJsonRepositories(f.security.store)
              : createPostgresRepositories(f.pool),
          logger() {},
        }).listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(
        () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(r);
          }),
      );
      const origin = "http://127.0.0.1:" + server.address().port,
        path =
          "/api/v1/companies/" +
          f.company +
          "/orders/" +
          f.order +
          "/internal-notes",
        sales = (await f.login(1)).accessToken;
      const call = (url, method = "GET", body, token = sales) =>
        fetch(origin + url, {
          method,
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const add = await call(path, "POST", { note: "PRIVATE_HTTP_NOTE" });
      assert.equal(add.status, 201);
      assert.equal(add.headers.get("cache-control"), "no-store");
      assert.equal(
        (await add.json()).data.note.authorUserId,
        f.data.users[1].id,
      );
      assert.equal((await call(path + "?offset=0&limit=2")).status, 200);
      assert.equal(
        (await call(path + "?authorUserId=" + f.data.users[0].id)).status,
        400,
      );
      for (const index of [2, 3]) {
        const token = (await f.login(index)).accessToken;
        assert.equal((await call(path, "GET", undefined, token)).status, 403);
        assert.equal(
          (await call(path, "POST", { note: "Forbidden" }, token)).status,
          403,
        );
        const orders = await call(
          "/api/v1/companies/" + f.company + "/orders",
          "GET",
          undefined,
          token,
        );
        assert.equal(orders.status, 200);
        assert.ok(!(await orders.text()).includes("PRIVATE_HTTP_NOTE"));
      }
      if (provider === "json")
        await writeFile(
          join(f.directory, "order_internal_notes.json"),
          "PRIVATE_CORRUPTION",
        );
      else await f.pool.query("DROP TABLE order_internal_notes");
      const failed = await call(path);
      assert.equal(failed.status, 503);
      assert.equal(failed.headers.get("cache-control"), "no-store");
      assert.ok(!(await failed.text()).includes("PRIVATE"));
    },
  );
}
