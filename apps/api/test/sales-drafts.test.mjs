import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authFixture, barrier } from "./helpers/auth-fixture.mjs";
import { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { createAuthorization } from "../dist/services/authorization.js";
import {
  createOrderDrafts,
  createSalesDrafts,
} from "../dist/services/order-drafts.js";
import { createPostgresOrderDrafts } from "../dist/infrastructure/postgres-order-drafts.js";
import { createJsonOrderDrafts } from "../dist/infrastructure/json/order-drafts.js";
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
    f.staff = f.data.users[1].id;
    const a = {
      id: randomUUID(),
      companyId: f.company,
      salesStaffUserId: f.staff,
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
        ? createJsonOrderDrafts(f.security, f.now)
        : createPostgresOrderDrafts(f.pool, f.now);
    f.events = [];
    f.factory = createSalesDrafts(f.repo, async (e) => {
      f.events.push(e);
      return f.record(e);
    });
    f.service = f.factory(f.company);
    f.actor = async (i = 1) =>
      createAuthorization(f.auth.authenticateAccess).admit(
        (await f.login(i)).accessToken,
        "profile.read",
      );
    f.sales = await f.actor();
    f.address = randomUUID();
    if (provider === "json")
      await writeFile(
        join(f.directory, "delivery_addresses.json"),
        JSON.stringify([
          {
            id: f.address,
            companyId: f.company,
            label: "Synthetic",
            address: { line1: "Test delivery" },
            active: true,
            isDefault: false,
          },
        ]),
      );
    else {
      await f.pool.query(
        "INSERT INTO delivery_addresses(id,company_id,label,address,active,is_default) VALUES($1,$2,$3,$4,true,false)",
        [f.address, f.company, "Synthetic", '{"line1":"Test delivery"}'],
      );
      for (const p of f.data.products)
        await f.pool.query(
          "INSERT INTO products(id,erp_product_reference,sku,name,selling_uom,minimum_order_quantity,active) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            p.id,
            p.erpProductReference,
            p.sku,
            p.name,
            p.sellingUom,
            p.minimumOrderQuantity,
            p.active,
          ],
        );
      for (const p of f.data.customer_product_access)
        await f.pool.query(
          "INSERT INTO customer_product_access(id,company_id,product_id,eligible) VALUES($1,$2,$3,$4)",
          [randomUUID(), p.companyId, p.productId, p.eligible],
        );
    }
    f.state = async (id, status) => {
      if (provider === "json")
        await f.security.run(async () =>
          f.security.store.replace(
            "orders",
            (await f.security.store.read("orders")).map((r) =>
              r.id === id ? { ...r, status } : r,
            ),
          ),
        );
      else
        await f.pool.query("UPDATE orders SET order_status=$1 WHERE id=$2", [
          status,
          id,
        ]);
    };
    return f;
  }
  test(
    `${provider}: assigned Sales creates/edits own unsubmitted draft, preserving item/address/version rules`,
    opts,
    async (t) => {
      const f = await setup(t),
        s = f.service,
        a = f.sales;
      let d = (await s.create(a, {}, randomUUID())).draft;
      assert.equal(d.createdByUserId, f.staff);
      assert.equal(d.companyId, f.company);
      assert.equal(d.status, "DRAFT");
      assert.equal(d.integrationStatus, "NOT_SENT");
      d = (
        await s.update(
          a,
          d.id,
          { version: d.version, deliveryAddressId: f.address },
          randomUUID(),
        )
      ).draft;
      await assert.rejects(
        s.update(
          a,
          d.id,
          { version: d.version, deliveryAddressId: randomUUID() },
          randomUUID(),
        ),
        { code: "not_found" },
      );
      const p = f.data.products.find(
        (p) =>
          p.active &&
          f.data.customer_product_access.some(
            (x) =>
              x.companyId === f.company && x.productId === p.id && x.eligible,
          ),
      );
      let added = await s.changeItem(
        a,
        d.id,
        undefined,
        "add",
        {
          version: d.version,
          productId: p.id,
          quantity: p.minimumOrderQuantity,
        },
        randomUUID(),
      );
      assert.equal(added.items.length, 1);
      assert.notEqual(added.draft.version, d.version);
      await assert.rejects(
        s.changeItem(
          a,
          d.id,
          undefined,
          "add",
          {
            version: added.draft.version,
            productId: randomUUID(),
            quantity: "1",
          },
          randomUUID(),
        ),
        { code: "not_found" },
      );
      await assert.rejects(
        s.update(
          a,
          d.id,
          { version: d.version, deliveryAddressId: null },
          randomUUID(),
        ),
        { code: "conflict" },
      );
      d = added.draft;
      const race = await Promise.allSettled([
        s.update(
          a,
          d.id,
          { version: d.version, deliveryAddressId: null },
          randomUUID(),
        ),
        s.update(
          a,
          d.id,
          { version: d.version, deliveryAddressId: f.address },
          randomUUID(),
        ),
      ]);
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      assert.ok(
        f.events.every(
          (e) => e.actorUserId === f.staff && e.companyId === f.company,
        ),
      );
      await f.state(d.id, "PENDING_CUSTOMER_CONFIRMATION");
      await assert.rejects(
        s.update(
          a,
          d.id,
          { version: d.version, deliveryAddressId: null },
          randomUUID(),
        ),
        { code: "conflict" },
      );
      assert.equal("submit" in s, false);
      assert.equal("acknowledgeTerms" in s, false);
    },
  );
  test(
    `${provider}: foreign company/creator/customer, reassignment, stale credential and copied actor cannot mutate`,
    opts,
    async (t) => {
      const f = await setup(t),
        s = f.service,
        a = f.sales,
        d = (await s.create(a, {}, randomUUID())).draft;
      await assert.rejects(
        s.find({ ...a }, d.id),
        (e) => e.name === "AuthorizationError",
      );
      await assert.rejects(
        s.create(await f.actor(2), {}, randomUUID()),
        (e) => e.name === "AuthorizationError",
      );
      await assert.rejects(
        createOrderDrafts(f.repo, f.record).create(a, {}, randomUUID()),
        (e) => e.name === "AuthorizationError",
      );
      await assert.rejects(
        f.factory(f.data.companies[1].id).create(a, {}, randomUUID()),
        { code: "forbidden" },
      );
      const customerDraft = await createOrderDrafts(f.repo, f.record).create(
        await f.actor(2),
        {},
        randomUUID(),
      );
      await assert.rejects(s.find(a, customerDraft.draft.id), {
        code: "not_found",
      });
      await f.assign(false);
      await assert.rejects(
        s.update(
          a,
          d.id,
          { version: d.version, deliveryAddressId: null },
          randomUUID(),
        ),
        { code: "forbidden" },
      );
      await f.assign(true);
      await f.setUser({ status: "SUSPENDED" }, 1);
      await assert.rejects(s.find(a, d.id), (e) =>
        ["forbidden", "invalid_proof", "inactive"].includes(e.code),
      );
    },
  );
  test(
    `${provider}: queued draft creation rechecks assignment at actual persistence`,
    opts,
    async (t) => {
      const f = await setup(t);
      if (provider === "json") {
        const entered = barrier(),
          release = barrier();
        const writer = f.security.run(async () => {
          entered.resolve();
          await release.promise;
          await writeFile(
            join(f.directory, "customer_sales_assignments.json"),
            "[]",
          );
        });
        await entered.promise;
        const pending = f.service.create(f.sales, {}, randomUUID());
        release.resolve();
        await writer;
        await assert.rejects(pending, { code: "forbidden" });
      } else {
        const pool = new Pool({ ...f.pool.options, max: 1 }),
          locker = await f.pool.connect();
        const pid = (await pool.query("SELECT pg_backend_pid() AS id")).rows[0]
          .id;
        let pending;
        try {
          await locker.query("BEGIN");
          await locker.query(
            "SELECT id FROM companies WHERE id=$1 FOR UPDATE",
            [f.company],
          );
          pending = createSalesDrafts(
            createPostgresOrderDrafts(pool, f.now),
            f.record,
          )(f.company).create(f.sales, {}, randomUUID());
          pending.catch(() => {});
          let waiting = false;
          for (let n = 0; n < 100; n++) {
            waiting = (
              await f.pool.query(
                "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
                [pid],
              )
            ).rows[0]?.waiting;
            if (waiting) break;
            await delay(10);
          }
          assert.equal(waiting, true);
          await locker.query(
            "DELETE FROM customer_sales_assignments WHERE company_id=$1",
            [f.company],
          );
          await locker.query("COMMIT");
          await assert.rejects(pending, { code: "forbidden" });
        } finally {
          await locker.query("ROLLBACK");
          locker.release();
          await pool.end();
        }
      }
    },
  );
  test(
    `${provider}: actual Sales HTTP routes validate bodies and deny customers, direct submit and confirmation`,
    opts,
    async (t) => {
      const f = await setup(t),
        server = createApp({
          sessions: f.auth,
          salesDrafts: f.factory,
          orderDrafts: createOrderDrafts(f.repo, f.record),
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
        path = "/api/v1/sales/companies/" + f.company + "/order-drafts",
        proof = await f.login(1);
      const call = (url, method, body, token = proof.accessToken) =>
        fetch(origin + url, {
          method,
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const created = await call(path, "POST", {});
      assert.equal(created.status, 201);
      assert.equal(created.headers.get("cache-control"), "no-store");
      const d = (await created.json()).data.draft;
      assert.equal((await call(path + "/" + d.id, "GET")).status, 200);
      assert.equal(
        (await call(path, "POST", { createdByUserId: f.data.users[2].id }))
          .status,
        400,
      );
      assert.equal(
        (await call(path, "POST", {}, (await f.login(2)).accessToken)).status,
        403,
      );
      assert.equal(
        (
          await call("/api/v1/order-drafts/" + d.id + "/submit", "POST", {
            version: d.version,
          })
        ).status,
        403,
      );
      assert.equal(
        (await call(path + "/" + d.id + "/confirm", "POST", {})).status,
        404,
      );
    },
  );
}
