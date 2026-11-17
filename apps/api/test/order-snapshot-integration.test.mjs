import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createOrderDrafts } from "../dist/services/order-drafts.js";
import { createJsonOrderDrafts } from "../dist/infrastructure/json/order-drafts.js";
import { createPostgresOrderDrafts } from "../dist/infrastructure/postgres-order-drafts.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createOrderSnapshot } from "../dist/services/order-snapshot.js";
import { commitJsonOrderSnapshot } from "../dist/infrastructure/json/order-snapshots.js";
import { withPostgresOrderSnapshot } from "../dist/infrastructure/postgres-order-snapshots.js";
async function fixture(t, provider) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.companyId = f.data.companies[0].id;
  f.addressId = randomUUID();
  if (provider === "json")
    await fs.writeFile(
      join(f.directory, "delivery_addresses.json"),
      JSON.stringify([
        {
          id: f.addressId,
          companyId: f.companyId,
          label: "Delivery",
          address: { line1: "First street" },
          contactName: null,
          contactPhone: null,
          active: true,
          isDefault: false,
        },
      ]),
    );
  else {
    await f.pool.query(
      "INSERT INTO delivery_addresses(id,company_id,label,address,active,is_default) VALUES($1,$2,'Delivery',$3::jsonb,true,false)",
      [f.addressId, f.companyId, JSON.stringify({ line1: "First street" })],
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
    for (const a of f.data.customer_product_access)
      await f.pool.query(
        "INSERT INTO customer_product_access(id,company_id,product_id,eligible) VALUES($1,$2,$3,$4)",
        [randomUUID(), a.companyId, a.productId, a.eligible],
      );
  }
  f.repo =
    provider === "json"
      ? createJsonOrderDrafts(f.security, f.now)
      : createPostgresOrderDrafts(f.pool, f.now);
  f.service = createOrderDrafts(f.repo, f.record);
  f.actor = await createAuthorization(f.auth.authenticateAccess).admit(
    (await f.login(2)).accessToken,
    "profile.read",
  );
  let draft = (
    await f.service.create(
      f.actor,
      { deliveryAddressId: f.addressId },
      randomUUID(),
    )
  ).draft;
  let result = await f.service.changeItem(
    f.actor,
    draft.id,
    undefined,
    "add",
    {
      version: draft.version,
      productId: f.data.products[0].id,
      quantity: "1.25",
    },
    randomUUID(),
  );
  f.draft = result.draft;
  f.snapshot = createOrderSnapshot({
    orderId: f.draft.id,
    companyId: f.companyId,
    submittedAt: new Date(f.now()).toISOString(),
    submittedBy: {
      id: f.actor.userId,
      companyId: f.companyId,
      displayName: f.data.users[2].displayName,
      role: f.actor.role,
    },
    delivery: {
      id: f.addressId,
      companyId: f.companyId,
      label: "Delivery",
      line1: "First street",
      contactName: null,
      contactPhone: null,
    },
    items: [
      {
        itemId: result.items[0].id,
        productId: result.items[0].productId,
        sku: "DEMO-P001",
        name: "Historic product",
        sellingUom: "Case",
        minimumOrderQuantity: "1",
        quantity: "1.25",
        unitPrice: "27.50",
        currency: "AED",
      },
    ],
  });
  f.commit = async (snapshot = f.snapshot, check = () => {}) =>
    provider === "json"
      ? commitJsonOrderSnapshot(
          f.security,
          f.draft.id,
          f.draft.version,
          async (row) => ({
            transitionedOrder: { ...row, status: "SUBMITTED" },
            snapshot,
          }),
          check,
        )
      : withPostgresOrderSnapshot(f.pool, async (c) => {
          await c.query(
            "UPDATE orders SET order_status='SUBMITTED',submitted_at=$1 WHERE id=$2",
            [snapshot.submittedAt, f.draft.id],
          );
          return snapshot;
        });
  return f;
}
test("JSON snapshot publication preserves other ERP links and invoice synchronization preserves submitted snapshots", async (t) => {
  const f = await fixture(t, "json"),
    erpOrderReference = randomUUID();
  const rows = await f.security.store.read("orders"),
    historical = rows.find((r) => r.status === "CONFIRMED");
  await f.security.store.replace(
    "orders",
    rows.map((r) => (r.id === historical.id ? { ...r, erpOrderReference } : r)),
  );
  await f.commit();
  const submitted = await f.security.store.read("orders");
  assert.equal(
    submitted.find((r) => r.id === historical.id).erpOrderReference,
    erpOrderReference,
  );
  assert.deepEqual(
    submitted.find((r) => r.id === f.draft.id).submittedSnapshot,
    f.snapshot,
  );
  const linked = randomUUID();
  await f.security.store.replace(
    "orders",
    submitted.map((r) =>
      r.id === f.draft.id ? { ...r, erpOrderReference: linked } : r,
    ),
  );
  const before = await fs.readFile(join(f.directory, "orders.json"), "utf8");
  const { createJsonInvoices } =
      await import("../dist/infrastructure/json/invoices.js"),
    repository = createJsonInvoices(f.security),
    link = await repository.link(f.draft.id);
  await repository.save(link, {
    id: randomUUID(),
    companyId: link.companyId,
    orderId: link.orderId,
    erpInvoiceReference: "TEST-INVOICE",
    invoiceNumber: "TEST-1",
    status: "available",
    amount: "100.00",
    currency: "AED",
    documentReference: `mock-invoice:${linked}`,
    issuedAt: new Date(f.now()).toISOString(),
    syncedAt: new Date(f.now()).toISOString(),
  });
  assert.equal(
    await fs.readFile(join(f.directory, "orders.json"), "utf8"),
    before,
  );
  assert.deepEqual(
    (await f.security.store.read("orders")).find((r) => r.id === f.draft.id)
      .submittedSnapshot,
    f.snapshot,
  );
});
test("JSON snapshot component refuses an already ERP-linked draft", async (t) => {
  const f = await fixture(t, "json"),
    rows = await f.security.store.read("orders");
  await f.security.store.replace(
    "orders",
    rows.map((r) =>
      r.id === f.draft.id ? { ...r, erpOrderReference: randomUUID() } : r,
    ),
  );
  await assert.rejects(f.commit(), /state conflict/);
});
for (const provider of ["json", "postgresql"]) {
  const opts = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "PostgreSQL URL required"
        : false,
  };
  test(
    provider +
      ": concurrent snapshot attempts serialize and never overwrite the first",
    opts,
    async (t) => {
      const f = await fixture(t, provider);
      const results = await Promise.allSettled([f.commit(), f.commit()]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      if (provider === "json") {
        const row = (await f.security.store.read("orders")).find(
          (o) => o.id === f.draft.id,
        );
        assert.equal(row.status, "SUBMITTED");
        assert.deepEqual(row.submittedSnapshot, f.snapshot);
      } else {
        const row = (
          await f.pool.query(
            "SELECT order_status,order_snapshot FROM orders WHERE id=$1",
            [f.draft.id],
          )
        ).rows[0];
        assert.equal(row.order_status, "SUBMITTED");
        assert.deepEqual(row.order_snapshot, f.snapshot);
      }
    },
  );
  test(
    provider +
      ": snapshot and caller transition publish atomically and retain history after source edits",
    opts,
    async (t) => {
      const f = await fixture(t, provider);
      const value = await f.commit();
      assert.equal(value.total, "34.375");
      let stored;
      if (provider === "json") {
        await f.security.store.replace(
          "products",
          (await f.security.store.read("products")).map((p) =>
            p.id === f.data.products[0].id ? { ...p, name: "Changed" } : p,
          ),
        );
        await f.security.store.replace(
          "users",
          (await f.security.store.read("users")).map((u) =>
            u.id === f.actor.userId
              ? { ...u, displayName: "Changed buyer" }
              : u,
          ),
        );
        await fs.writeFile(
          join(f.directory, "delivery_addresses.json"),
          JSON.stringify([
            {
              id: f.addressId,
              companyId: f.companyId,
              label: "Changed",
              address: { line1: "Changed street" },
              active: true,
              isDefault: false,
            },
          ]),
        );
        stored = (await f.security.store.read("orders")).find(
          (o) => o.id === f.draft.id,
        ).submittedSnapshot;
      } else {
        await f.pool.query("UPDATE products SET name='Changed' WHERE id=$1", [
          f.data.products[0].id,
        ]);
        await f.pool.query(
          "UPDATE users SET display_name='Changed buyer' WHERE id=$1",
          [f.actor.userId],
        );
        await f.pool.query(
          "UPDATE delivery_addresses SET address=$1::jsonb WHERE id=$2",
          [JSON.stringify({ line1: "Changed street" }), f.addressId],
        );
        const row = (
          await f.pool.query(
            "SELECT order_snapshot AS snapshot,order_status AS status,total_amount::text AS total FROM orders WHERE id=$1",
            [f.draft.id],
          )
        ).rows[0];
        assert.equal(row.status, "SUBMITTED");
        assert.equal(row.total, "34.375");
        stored = row.snapshot;
        const line = (
          await f.pool.query(
            "SELECT item_snapshot AS snapshot,unit_price::text AS price,line_total::text AS total FROM order_items WHERE order_id=$1",
            [f.draft.id],
          )
        ).rows[0];
        assert.equal(line.snapshot.name, "Historic product");
        assert.equal(line.price, "27.50");
        assert.equal(line.total, "34.375");
      }
      assert.deepEqual(stored, value);
      assert.equal(stored.items[0].name, "Historic product");
      assert.equal(stored.delivery.line1, "First street");
      assert.equal(stored.submittedBy.displayName, f.data.users[2].displayName);
      const reads =
        provider === "json"
          ? createJsonRepositories(f.security.store)
          : createPostgresRepositories(f.pool);
      const summary = await reads.orders.findById(
        { companyId: f.companyId },
        f.draft.id,
      );
      assert.equal(summary.status, "SUBMITTED");
      assert.equal(JSON.stringify(summary).includes("Historic product"), false);
      await assert.rejects(f.commit());
      await assert.rejects(f.service.find(f.actor, f.draft.id));
    },
  );
  test(
    provider +
      ": mismatched snapshot and failed publication never leave a partial submitted record",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        bad = structuredClone(f.snapshot);
      bad.items[0].quantity = "9";
      await assert.rejects(f.commit(bad));
      if (provider === "json") {
        assert.equal(
          (await f.security.store.read("orders")).find(
            (o) => o.id === f.draft.id,
          ).status,
          "DRAFT",
        );
        await assert.rejects(
          f.commit(f.snapshot, () => {
            throw Error("STALE_AUTH");
          }),
        );
        assert.equal(
          (await f.security.store.read("orders")).find(
            (o) => o.id === f.draft.id,
          ).status,
          "DRAFT",
        );
      } else {
        assert.equal(
          (
            await f.pool.query("SELECT order_status FROM orders WHERE id=$1", [
              f.draft.id,
            ])
          ).rows[0].order_status,
          "DRAFT",
        );
        await f.pool.query(
          "CREATE FUNCTION fail_snapshot() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''synthetic failure''; END'; CREATE TRIGGER fail_snapshot_line BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION fail_snapshot()",
        );
        await assert.rejects(f.commit());
        const row = (
          await f.pool.query(
            "SELECT order_status,order_snapshot FROM orders WHERE id=$1",
            [f.draft.id],
          )
        ).rows[0];
        assert.equal(row.order_status, "DRAFT");
        assert.equal(row.order_snapshot, null);
      }
    },
  );
}
test("JSON failure before and after atomic publication never splits state from snapshot", async (t) => {
  for (const after of [false, true]) {
    const f = await fixture(t, "json"),
      original = f.security.store.replace.bind(f.security.store);
    f.security.store.replace = async (name, rows) => {
      if (after) await original(name, rows);
      throw Error("SYNTHETIC_IO");
    };
    await assert.rejects(f.commit());
    f.security.store.replace = original;
    const row = (await f.security.store.read("orders")).find(
      (o) => o.id === f.draft.id,
    );
    assert.equal(row.status, after ? "SUBMITTED" : "DRAFT");
    assert.equal(Boolean(row.submittedSnapshot), after);
  }
});
test("JSON refuses unknown private order fields without discarding them", async (t) => {
  const f = await fixture(t, "json"),
    path = join(f.directory, "orders.json"),
    rows = JSON.parse(await fs.readFile(path, "utf8"));
  rows.find((r) => r.id === f.draft.id).futurePrivate = { keep: "value" };
  await fs.writeFile(path, JSON.stringify(rows));
  const before = await fs.readFile(path, "utf8");
  await assert.rejects(f.commit());
  assert.equal(await fs.readFile(path, "utf8"), before);
});
test("JSON rejects a stored snapshot whose identity no longer matches its order", async (t) => {
  const f = await fixture(t, "json");
  await f.commit();
  const path = join(f.directory, "orders.json"),
    rows = JSON.parse(await fs.readFile(path, "utf8"));
  rows.find((r) => r.id === f.draft.id).submittedSnapshot.submittedBy.id =
    randomUUID();
  await fs.writeFile(path, JSON.stringify(rows));
  const before = await fs.readFile(path, "utf8");
  await assert.rejects(f.security.store.read("orders"));
  await assert.rejects(f.service.create(f.actor, {}, randomUUID()));
  assert.equal(await fs.readFile(path, "utf8"), before);
});
