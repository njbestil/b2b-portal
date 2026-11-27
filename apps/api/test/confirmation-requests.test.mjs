import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import {
  createOrderDrafts,
  createSalesDrafts,
} from "../dist/services/order-drafts.js";
import { createPostgresOrderDrafts } from "../dist/infrastructure/postgres-order-drafts.js";
import { createJsonOrderDrafts } from "../dist/infrastructure/json/order-drafts.js";
import { createConfirmationRequests } from "../dist/services/confirmation-requests.js";
import { createPostgresConfirmationRequests } from "../dist/infrastructure/postgres-confirmation-requests.js";
import { createJsonConfirmationRequests } from "../dist/infrastructure/json/confirmation-requests.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createApp } from "../dist/app.js";
async function fixture(t, provider) {
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
      await f.pool.query("DELETE FROM customer_sales_assignments WHERE id=$1", [
        a.id,
      ]);
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
  f.confirmRepo =
    provider === "json"
      ? createJsonConfirmationRequests(f.security, f.now)
      : createPostgresConfirmationRequests(f.pool, f.now);
  f.confirm = createConfirmationRequests(f.confirmRepo, f.record);
  let draft = (
    await f.service.create(
      f.sales,
      { deliveryAddressId: f.address },
      randomUUID(),
    )
  ).draft;
  f.draft = (
    await f.service.changeItem(
      f.sales,
      draft.id,
      undefined,
      "add",
      {
        version: draft.version,
        productId: f.data.products[0].id,
        quantity: f.data.products[0].minimumOrderQuantity,
      },
      randomUUID(),
    )
  ).draft;
  f.key = randomUUID();
  f.body = { version: f.draft.version, customerUserId: f.data.users[3].id };
  f.request = (s = f.confirm, body = f.body, key = f.key) =>
    s.request(f.sales, f.company, f.draft.id, key, body, randomUUID());
  f.read = () => f.confirm.find(f.sales, f.company, f.draft.id);
  f.raw = async () =>
    provider === "json"
      ? (await f.security.store.read("orders")).find((r) => r.id === f.draft.id)
      : (
          await f.pool.query(
            'SELECT order_status AS status,integration_status AS "integrationStatus" FROM orders WHERE id=$1',
            [f.draft.id],
          )
        ).rows[0];
  return f;
}
for (const provider of ["json", "postgresql"]) {
  const opts = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "PostgreSQL required"
        : false,
  };
  test(
    `${provider}: request and concurrent replay persist one pending confirmation with locked order and private fingerprint`,
    opts,
    async (t) => {
      const f = await fixture(t, provider);
      assert.deepEqual(await f.read(), { confirmation: null });
      const [a, b] = await Promise.all([f.request(), f.request()]);
      assert.deepEqual(a, b);
      assert.equal(a.confirmation.customerUserId, f.data.users[3].id);
      assert.equal(a.confirmation.status, "PENDING");
      assert.equal((await f.raw()).status, "PENDING_CUSTOMER_CONFIRMATION");
      assert.equal((await f.raw()).integrationStatus, "NOT_SENT");
      assert.deepEqual(await f.read(), a);
      assert.ok(!JSON.stringify(a).includes("fingerprint"));
      assert.ok(!JSON.stringify(a).includes(f.key));
      await assert.rejects(f.request(f.confirm, f.body, randomUUID()), {
        code: "conflict",
      });
      await assert.rejects(
        f.request(f.confirm, { ...f.body, customerUserId: f.data.users[2].id }),
        { code: "conflict" },
      );
      await assert.rejects(
        f.service.update(
          f.sales,
          f.draft.id,
          { version: f.draft.version, deliveryAddressId: null },
          randomUUID(),
        ),
        { code: "conflict" },
      );
      if (provider === "postgresql") {
        assert.equal(
          (
            await f.pool.query(
              "SELECT count(*)::int AS n FROM order_confirmations WHERE order_id=$1",
              [f.draft.id],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await f.pool.query(
              "SELECT count(*)::int AS n FROM integration_transactions",
            )
          ).rows[0].n,
          0,
        );
      }
    },
  );
  test(
    `${provider}: customer/foreign contact/creator, malformed body, stale version, reassignment and expired proofs cannot request`,
    opts,
    async (t) => {
      const f = await fixture(t, provider);
      for (const actor of [await f.actor(0), await f.actor(2), { ...f.sales }])
        await assert.rejects(
          f.confirm.request(
            actor,
            f.company,
            f.draft.id,
            f.key,
            f.body,
            randomUUID(),
          ),
          (e) => e.name === "AuthorizationError",
        );
      for (const contact of [
        f.data.users[0].id,
        f.data.users[4].id,
        randomUUID(),
      ])
        await assert.rejects(
          f.request(f.confirm, { ...f.body, customerUserId: contact }),
          { code: "not_found" },
        );
      await f.setUser({ status: "SUSPENDED" }, 3);
      await assert.rejects(f.request(), { code: "not_found" });
      await f.setUser({ status: "ACTIVE" }, 3);
      await assert.rejects(
        f.request(f.confirm, { ...f.body, version: "draft-" + "0".repeat(64) }),
        { code: "conflict" },
      );
      await assert.rejects(
        f.request(f.confirm, { ...f.body, status: "CONFIRMED" }),
        { code: "invalid_input" },
      );
      const other = (
        await createOrderDrafts(f.repo, f.record).create(
          await f.actor(2),
          {},
          randomUUID(),
        )
      ).draft;
      await assert.rejects(
        f.confirm.request(
          f.sales,
          f.company,
          other.id,
          f.key,
          { ...f.body, version: other.version },
          randomUUID(),
        ),
        { code: "not_found" },
      );
      await f.assign(false);
      await assert.rejects(f.request(), { code: "forbidden" });
      await f.assign(true);
      f.clock.value = Date.parse(f.sales.accessExpiresAt) + 1;
      await assert.rejects(f.request(), { code: "invalid_proof" });
    },
  );
  test(
    `${provider}: draft edit versus confirmation request has one winner and no split state`,
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        results = await Promise.allSettled([
          f.request(),
          f.service.update(
            f.sales,
            f.draft.id,
            { version: f.draft.version, deliveryAddressId: null },
            randomUUID(),
          ),
        ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.find((r) => r.status === "rejected").reason.code,
        "conflict",
      );
      const read = await f.read();
      assert.equal(
        (await f.raw()).status,
        read.confirmation ? "PENDING_CUSTOMER_CONFIRMATION" : "DRAFT",
      );
    },
  );
  test(
    `${provider}: failed publication is atomic; unconfirmed committed publication reopens/replays canonically`,
    opts,
    async (t) => {
      const f = await fixture(t, provider);
      if (provider === "json") {
        const failed = createConfirmationRequests(
          createJsonConfirmationRequests(f.security, f.now, {
            ...fs,
            async rename() {
              throw new Error("PRIVATE_WRITE");
            },
          }),
          f.record,
        );
        await assert.rejects(f.request(failed), { code: "unavailable" });
        assert.equal((await f.raw()).status, "DRAFT");
        assert.deepEqual(await f.read(), { confirmation: null });
        const uncertain = createConfirmationRequests(
          createJsonConfirmationRequests(f.security, f.now, {
            ...fs,
            async rename(...args) {
              await fs.rename(...args);
              throw new Error("PRIVATE_AFTER_COMMIT");
            },
          }),
          f.record,
        );
        await assert.rejects(f.request(uncertain), { code: "unavailable" });
        const saved = await f.read();
        assert.ok(saved.confirmation);
        assert.equal((await f.raw()).status, "PENDING_CUSTOMER_CONFIRMATION");
        assert.deepEqual(await f.request(), saved);
      } else {
        await f.pool.query(
          "ALTER TABLE orders ADD CONSTRAINT deny_pending CHECK (order_status<>'PENDING_CUSTOMER_CONFIRMATION') NOT VALID",
        );
        await assert.rejects(f.request(), { code: "unavailable" });
        assert.equal((await f.raw()).status, "DRAFT");
        assert.deepEqual(await f.read(), { confirmation: null });
        await f.pool.query("ALTER TABLE orders DROP CONSTRAINT deny_pending");
        const saved = await f.request();
        assert.deepEqual(await f.read(), saved);
        assert.deepEqual(await f.request(), saved);
      }
    },
  );
  test(
    `${provider}: real HTTP enforces keyed request contract, safe status reads and customer history privacy`,
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        http = createApp({
          sessions: f.auth,
          confirmationRequests: f.confirm,
          companyRepositories:
            provider === "json"
              ? createJsonRepositories(f.security.store)
              : createPostgresRepositories(f.pool),
          logger() {},
        }).listen(0, "127.0.0.1");
      await once(http, "listening");
      t.after(
        () =>
          new Promise((r) => {
            http.closeAllConnections();
            http.close(r);
          }),
      );
      const origin = "http://127.0.0.1:" + http.address().port,
        path =
          "/api/v1/sales/companies/" +
          f.company +
          "/orders/" +
          f.draft.id +
          "/confirmation",
        token = (await f.login(1)).accessToken;
      const post = (body = f.body, key = f.key, who = token) =>
        fetch(origin + path, {
          method: "POST",
          headers: {
            authorization: "Bearer " + who,
            "content-type": "application/json",
            ...(key ? { "idempotency-key": key } : {}),
          },
          body: JSON.stringify(body),
        });
      assert.equal((await post(f.body, null)).status, 400);
      assert.equal(
        (await post(f.body, f.key, (await f.login(2)).accessToken)).status,
        403,
      );
      const response = await post();
      assert.equal(response.status, 202);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const result = await response.json();
      assert.equal(result.data.confirmation.status, "PENDING");
      assert.ok(!JSON.stringify(result).includes("fingerprint"));
      const get = await fetch(origin + path, {
        headers: { authorization: "Bearer " + token },
      });
      assert.equal(get.status, 200);
      assert.deepEqual((await get.json()).data, result.data);
      const history = await fetch(
        origin + "/api/v1/companies/" + f.company + "/order-history",
        {
          headers: {
            authorization: "Bearer " + (await f.login(2)).accessToken,
          },
        },
      );
      assert.equal(history.status, 200);
      const publicBody = await history.text();
      assert.ok(!publicBody.includes("fingerprint"));
      assert.ok(!publicBody.includes(result.data.confirmation.id));
    },
  );
  test(
    `${provider}: other draft writes retain pending confirmation and protected private data never disappears`,
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        saved = await f.request(),
        customer = await f.actor(2),
        drafts = createOrderDrafts(f.repo, f.record);
      let d = (await drafts.create(customer, {}, randomUUID())).draft;
      await drafts.update(
        customer,
        d.id,
        { version: d.version, deliveryAddressId: f.address },
        randomUUID(),
      );
      assert.deepEqual(await f.read(), saved);
      if (provider === "json") {
        const raw = JSON.parse(
          await fs.readFile(join(f.directory, "orders.json"), "utf8"),
        );
        raw.find((r) => r.id === f.draft.id).confirmation.unknownPrivate =
          "KEEP";
        await fs.writeFile(
          join(f.directory, "orders.json"),
          JSON.stringify(raw),
        );
        await assert.rejects(drafts.create(customer, {}, randomUUID()), {
          code: "unavailable",
        });
        assert.ok(
          (
            await fs.readFile(join(f.directory, "orders.json"), "utf8")
          ).includes("KEEP"),
        );
      }
    },
  );
}
