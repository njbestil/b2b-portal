import { createCustomerConfirmations } from "../dist/services/customer-confirmations.js";
import { createJsonCustomerConfirmations } from "../dist/infrastructure/json/customer-confirmations.js";
import { createPostgresCustomerConfirmations } from "../dist/infrastructure/postgres-customer-confirmations.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createSalesDrafts } from "../dist/services/order-drafts.js";
import { createPostgresOrderDrafts } from "../dist/infrastructure/postgres-order-drafts.js";
import { createJsonOrderDrafts } from "../dist/infrastructure/json/order-drafts.js";
import { createConfirmationRequests } from "../dist/services/confirmation-requests.js";
import { createPostgresConfirmationRequests } from "../dist/infrastructure/postgres-confirmation-requests.js";
import { createJsonConfirmationRequests } from "../dist/infrastructure/json/confirmation-requests.js";
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
  async function setup(t) {
    const f = await fixture(t, provider);
    f.decisions =
      provider === "json"
        ? createJsonCustomerConfirmations(f.security, f.now)
        : createPostgresCustomerConfirmations(f.pool, f.now);
    f.decide = createCustomerConfirmations(f.decisions, f.record);
    f.contact = await f.actor(3);
    f.admin = await f.actor(2);
    f.requested = await f.request();
    f.auditEvents = [];
    f.beforeAudit = async (e) => {
      f.auditEvents.push(e);
    };
    f.input = (decision = "CONFIRMED", reason = null) => ({
      confirmationId: f.requested.confirmation.id,
      decision,
      reason,
    });
    f.command = (actor = f.contact, decision = "CONFIRMED", reason = null) =>
      f.decide.decide(
        actor,
        f.draft.id,
        f.input(decision, reason),
        randomUUID(),
      );
    return f;
  }
  test(
    `${provider}: designated customer confirms exactly once, keeps ERP unsent and replay survives reopen`,
    opts,
    async (t) => {
      const f = await setup(t),
        before = await f.decide.find(f.contact, f.draft.id);
      assert.equal(before.order.delivery.line1, "Test delivery");
      assert.equal(before.order.items.length, 1);
      assert.equal(before.confirmation.status, "PENDING");
      assert.doesNotMatch(
        JSON.stringify(before),
        /fingerprint|passwordHash|internalNotes|erpOrderReference/,
      );
      const [a, b] = await Promise.all([f.command(), f.command()]);
      assert.deepEqual(a, b);
      assert.equal(a.confirmation.status, "CONFIRMED");
      assert.equal(a.order.status, "PENDING_CUSTOMER_CONFIRMATION");
      assert.equal((await f.raw()).integrationStatus, "NOT_SENT");
      const reopened = createCustomerConfirmations(
        provider === "json"
          ? createJsonCustomerConfirmations(f.security, f.now)
          : createPostgresCustomerConfirmations(f.pool, f.now),
        f.record,
      );
      assert.deepEqual(await reopened.find(f.contact, f.draft.id), a);
      assert.equal((await f.read()).confirmation.status, "CONFIRMED");
      await assert.rejects(f.request(), { code: "conflict" });
      await assert.rejects(f.command(f.contact, "REJECTED", "Changed mind"), {
        code: "conflict",
      });
      await assert.rejects(
        f.service.update(
          f.sales,
          f.draft.id,
          { version: f.draft.version, deliveryAddressId: null },
          randomUUID(),
        ),
        { code: "conflict" },
      );
      assert.ok(
        f.auditEvents.some((e) => e.action === "order.customer_confirmed"),
      );
    },
  );
  test(
    `${provider}: Customer Admin may decide; Sales and other company/customer cannot approve`,
    opts,
    async (t) => {
      const f = await setup(t);
      await assert.rejects(f.command(f.sales));
      await assert.rejects(f.command(await f.actor(0)));
      await assert.rejects(f.command(await f.actor(5)), { code: "not_found" });
      const result = await f.command(
        f.admin,
        "REJECTED",
        "  Duplicate order  ",
      );
      assert.equal(result.confirmation.reason, "Duplicate order");
      assert.equal(result.order.status, "REJECTED");
      assert.equal((await f.raw()).status, "REJECTED");
      assert.deepEqual(
        await f.command(f.admin, "REJECTED", "Duplicate order"),
        result,
      );
      await assert.rejects(
        f.command(f.contact, "REJECTED", "Duplicate order"),
        { code: "conflict" },
      );
      const g = await fixture(t, provider);
      g.body.customerUserId = g.data.users[2].id;
      await g.request();
      const svc = createCustomerConfirmations(
        provider === "json"
          ? createJsonCustomerConfirmations(g.security, g.now)
          : createPostgresCustomerConfirmations(g.pool, g.now),
        g.record,
      );
      await assert.rejects(svc.find(await g.actor(3), g.draft.id), {
        code: "not_found",
      });
    },
  );
  test(
    `${provider}: one opposing decision wins and malformed/stale decisions never publish`,
    opts,
    async (t) => {
      const f = await setup(t);
      for (const body of [
        f.input("REJECTED", " "),
        f.input("REJECTED", "x".repeat(1001)),
        f.input("REJECTED", "bad\nreason"),
        f.input("CONFIRMED", "unexpected"),
        { ...f.input(), confirmationId: randomUUID() },
        { ...f.input(), companyId: f.company },
      ])
        await assert.rejects(
          f.decide.decide(f.contact, f.draft.id, body, randomUUID()),
        );
      assert.equal(
        (await f.decide.find(f.contact, f.draft.id)).confirmation.status,
        "PENDING",
      );
      const results = await Promise.allSettled([
        f.command(),
        f.command(f.contact, "REJECTED", "No longer required"),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.filter((r) => r.status === "rejected")[0].reason.code,
        "conflict",
      );
      const current = await f.decide.find(f.contact, f.draft.id);
      assert.equal(
        current.order.status,
        current.confirmation.status === "REJECTED"
          ? "REJECTED"
          : "PENDING_CUSTOMER_CONFIRMATION",
      );
    },
  );
  test(
    `${provider}: live suspension, restriction, revocation and access expiry reject admitted stale actors`,
    opts,
    async (t) => {
      const f = await setup(t);
      await f.setUser({ status: "SUSPENDED" }, 3);
      await assert.rejects(f.command());
      await f.setUser({ status: "ACTIVE", mustChangePassword: true }, 3);
      await assert.rejects(f.command());
      await f.setUser({ mustChangePassword: false }, 3);
      const sessions = await f.rows(),
        row = sessions.find((r) => r.userId === f.contact.userId);
      if (provider === "json") {
        const rows = sessions.map((r) =>
          r.id === row.id
            ? { ...r, revokedAt: new Date(f.now()).toISOString() }
            : r,
        );
        await writeFile(
          join(f.directory, "user_sessions.json"),
          JSON.stringify(rows),
        );
      } else
        await f.pool.query(
          "UPDATE user_sessions SET revoked_at=$1 WHERE id=$2",
          [new Date(f.now()).toISOString(), row.id],
        );
      await assert.rejects(f.command());
      const fresh = await f.actor(3);
      f.clock.value = Date.parse(fresh.accessExpiresAt);
      await assert.rejects(f.command(fresh));
      assert.equal((await f.raw()).status, "PENDING_CUSTOMER_CONFIRMATION");
    },
  );
  test(
    `${provider}: actual HTTP denies forged scope/roles and strict decision errors stay no-store`,
    opts,
    async (t) => {
      const f = await setup(t),
        app = createApp({
          sessions: f.auth,
          customerConfirmations: f.decide,
          logger() {},
        }),
        server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(
        () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(r);
          }),
      );
      const path = `http://127.0.0.1:${server.address().port}/api/v1/orders/${f.draft.id}/confirmation`,
        token = (await f.login(3)).accessToken;
      assert.equal((await fetch(path)).status, 401);
      for (const i of [0, 1])
        assert.equal(
          (
            await fetch(path, {
              headers: {
                Authorization: "Bearer " + (await f.login(i)).accessToken,
              },
            })
          ).status,
          403,
        );
      assert.equal(
        (
          await fetch(path + "?companyId=" + f.company, {
            headers: { Authorization: "Bearer " + token },
          })
        ).status,
        400,
      );
      for (let n = 0; n < 6; n++)
        assert.equal(
          (await fetch(path, { headers: { Authorization: "Bearer " + token } }))
            .status,
          200,
        );
      const post = await fetch(path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          f.input("REJECTED", "Different delivery required"),
        ),
      });
      assert.equal(post.status, 202);
      assert.equal(post.headers.get("cache-control"), "no-store");
      const body = await post.json();
      assert.equal(body.data.confirmation.status, "REJECTED");
      assert.doesNotMatch(
        JSON.stringify(body),
        /fingerprint|password|erpOrderReference/,
      );
    },
  );
  test(
    `${provider}: failed publication rolls back; lost acknowledgement and audit failure retain a recoverable decision`,
    opts,
    async (t) => {
      const f = await setup(t);
      if (provider === "json") {
        const before = createCustomerConfirmations(
          createJsonCustomerConfirmations(f.security, f.now, {
            ...fs,
            rename: async () => {
              throw Error("PRIVATE");
            },
          }),
          f.record,
        );
        await assert.rejects(
          before.decide(f.contact, f.draft.id, f.input(), randomUUID()),
        );
        assert.equal(
          (await f.decide.find(f.contact, f.draft.id)).confirmation.status,
          "PENDING",
        );
        const after = createCustomerConfirmations(
          createJsonCustomerConfirmations(f.security, f.now, {
            ...fs,
            rename: async (...args) => {
              await fs.rename(...args);
              throw Error("PRIVATE");
            },
          }),
          f.record,
        );
        await assert.rejects(
          after.decide(f.contact, f.draft.id, f.input(), randomUUID()),
        );
        assert.equal(
          (await f.decide.find(f.contact, f.draft.id)).confirmation.status,
          "CONFIRMED",
        );
        assert.equal((await f.command()).confirmation.status, "CONFIRMED");
      } else {
        await f.pool.query(
          "CREATE FUNCTION refuse_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE'; END $$; CREATE TRIGGER refuse_decision BEFORE UPDATE ON order_confirmations FOR EACH ROW EXECUTE FUNCTION refuse_decision()",
        );
        await assert.rejects(f.command(), { code: "unavailable" });
        assert.equal(
          (await f.decide.find(f.contact, f.draft.id)).confirmation.status,
          "PENDING",
        );
        await f.pool.query(
          "DROP TRIGGER refuse_decision ON order_confirmations",
        );
        const svc = createCustomerConfirmations(f.decisions, async () => {
          throw Error("PRIVATE");
        });
        await assert.rejects(
          svc.decide(f.contact, f.draft.id, f.input(), randomUUID()),
          { code: "unavailable" },
        );
        assert.equal(
          (await f.decide.find(f.contact, f.draft.id)).confirmation.status,
          "CONFIRMED",
        );
        assert.equal((await f.command()).confirmation.status, "CONFIRMED");
      }
      await f.service.create(
        f.sales,
        { deliveryAddressId: f.address },
        randomUUID(),
      );
      assert.equal(
        (await f.decide.find(f.contact, f.draft.id)).confirmation.status,
        "CONFIRMED",
      );
    },
  );
}
