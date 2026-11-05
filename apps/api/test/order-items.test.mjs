import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createOrderDrafts } from "../dist/services/order-drafts.js";
import {
  draftQuantity,
  requireMinimum,
} from "../dist/services/draft-quantities.js";
import { createJsonOrderDrafts } from "../dist/infrastructure/json/order-drafts.js";
import { createPostgresOrderDrafts } from "../dist/infrastructure/postgres-order-drafts.js";
import { createApp } from "../dist/app.js";
const code = (c) => (e) => e.code === c;
async function fixture(t, provider, options = {}) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  if (provider === "postgresql") {
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
      ? createJsonOrderDrafts(f.security, f.now, options)
      : createPostgresOrderDrafts(f.pool, f.now);
  f.events = [];
  f.service = createOrderDrafts(f.repo, async (e) => {
    f.events.push(e);
    return f.record(e);
  });
  f.actor = async (i = 2) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(i)).accessToken,
      "profile.read",
    );
  f.ca = await f.actor();
  f.cu = await f.actor(3);
  f.other = await f.actor(4);
  f.draft = (await f.service.create(f.ca, {}, randomUUID())).draft;
  f.read = (actor = f.ca, id = f.draft.id) => f.service.items(actor, id);
  f.change = (kind, body, itemId, actor = f.ca, id = f.draft.id) =>
    f.service.changeItem(actor, id, itemId, kind, body, randomUUID());
  f.add = (
    version = f.draft.version,
    quantity = "0.125",
    productId = f.data.products[2].id,
  ) => f.change("add", { version, quantity, productId });
  f.product = async (patch, index = 2) => {
    const id = f.data.products[index].id;
    if (provider === "json")
      await f.security.run(async () =>
        f.security.store.replace(
          "products",
          (await f.security.store.read("products")).map((p) =>
            p.id === id ? { ...p, ...patch } : p,
          ),
        ),
      );
    else
      for (const [k, v] of Object.entries(patch))
        await f.pool.query(
          "UPDATE products SET " +
            {
              active: "active",
              minimumOrderQuantity: "minimum_order_quantity",
            }[k] +
            "=$1 WHERE id=$2",
          [v, id],
        );
  };
  f.state = async (status) => {
    if (provider === "json")
      await f.security.store.replace(
        "orders",
        (await f.security.store.read("orders")).map((r) =>
          r.id === f.draft.id ? { ...r, status } : r,
        ),
      );
    else
      await f.pool.query("UPDATE orders SET order_status=$1 WHERE id=$2", [
        status,
        f.draft.id,
      ]);
  };
  return f;
}
test("exact quantity transport and MOQ minimum only, including precision boundaries", () => {
  for (const value of [
    "0",
    "0.000000",
    "-1",
    "+1",
    "1e2",
    "01",
    " 1",
    "1.",
    ".5",
    "1.0000000",
    "1000000000000",
    1,
    null,
    {},
    "NaN",
    "Infinity",
  ])
    assert.throws(() => draftQuantity(value), code("invalid_quantity"));
  assert.equal(draftQuantity("999999999999.999999"), "999999999999.999999");
  assert.equal(draftQuantity("0.000001"), "0.000001");
  assert.equal(draftQuantity("1.250000"), "1.25");
  requireMinimum("0.126", "0.125");
  requireMinimum("1.25", "1");
  requireMinimum("1", "0.999999999999999999");
  assert.throws(
    () => requireMinimum("1", "1.000000000000000001"),
    code("invalid_quantity"),
  );
  assert.throws(
    () => requireMinimum("0.124999", "0.125"),
    code("invalid_quantity"),
  );
});
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "PostgreSQL URL required"
        : false,
  };
  test(
    provider +
      ": canonical item CRUD, MOQ minimum, fractional non-KG, absolute updates and explicit deletion",
    options,
    async (t) => {
      const f = await fixture(t, provider);
      assert.deepEqual(await f.read(), { draft: f.draft, items: [] });
      let result = await f.add(undefined, "0.126000");
      assert.equal(result.items[0].quantity, "0.126");
      assert.deepEqual(Object.keys(result.items[0]).sort(), [
        "id",
        "productId",
        "quantity",
      ]);
      assert.notEqual(result.draft.version, f.draft.version);
      result = await f.add(result.draft.version, "1.5", f.data.products[0].id);
      assert.equal(result.items.length, 2);
      const item = result.items.find(
        (i) => i.productId === f.data.products[2].id,
      );
      const before = result.draft.version;
      result = await f.change(
        "update",
        { version: before, quantity: "0.126" },
        item.id,
      );
      assert.notEqual(result.draft.version, before);
      assert.equal(
        result.items.find((i) => i.id === item.id).quantity,
        "0.126",
      );
      await assert.rejects(
        f.service.remove(
          f.ca,
          f.draft.id,
          { version: result.draft.version },
          randomUUID(),
        ),
        code("conflict"),
      );
      for (const line of result.items)
        result = await f.change(
          "remove",
          { version: result.draft.version },
          line.id,
        );
      assert.deepEqual(result.items, []);
      await assert.rejects(
        f.change("remove", { version: result.draft.version }, item.id),
        code("not_found"),
      );
      await f.service.remove(
        f.ca,
        f.draft.id,
        { version: result.draft.version },
        randomUUID(),
      );
      assert.ok(f.events.some((e) => e.action === "order.draft_item_added"));
      assert.ok(f.events.some((e) => e.action === "order.draft_item_updated"));
      assert.ok(f.events.some((e) => e.action === "order.draft_item_removed"));
      const own = (await f.service.create(f.cu, {}, randomUUID())).draft;
      const cu = await f.change(
        "add",
        {
          version: own.version,
          quantity: "1",
          productId: f.data.products[0].id,
        },
        undefined,
        f.cu,
        own.id,
      );
      assert.equal(cu.items.length, 1);
    },
  );
  test(
    provider +
      ": ownership, lifecycle, eligibility, strict bodies and dynamic MOQ do not mutate on rejection",
    options,
    async (t) => {
      const f = await fixture(t, provider);
      for (const actor of [f.cu, f.other]) {
        await assert.rejects(f.read(actor), code("not_found"));
        await assert.rejects(
          f.change(
            "add",
            {
              version: f.draft.version,
              quantity: "1",
              productId: f.data.products[0].id,
            },
            undefined,
            actor,
          ),
          code("not_found"),
        );
      }
      for (const index of [0, 1])
        await assert.rejects(
          f.read(await f.actor(index)),
          (e) => e.name === "AuthorizationError" || e.code === "forbidden",
        );
      for (const extra of [
        { companyId: f.ca.companyId },
        { unitPrice: "1" },
        { snapshot: {} },
        { id: randomUUID() },
      ])
        await assert.rejects(
          f.change("add", {
            version: f.draft.version,
            productId: f.data.products[0].id,
            quantity: "1",
            ...extra,
          }),
          code("invalid_input"),
        );
      await assert.rejects(
        f.add(undefined, "0.124999"),
        code("invalid_quantity"),
      );
      await assert.rejects(
        f.add(undefined, "1", randomUUID()),
        code("not_found"),
      );
      let r = await f.add();
      await assert.rejects(f.add(r.draft.version), code("conflict"));
      await assert.rejects(
        f.change(
          "update",
          { version: r.draft.version, quantity: "0" },
          r.items[0].id,
        ),
        code("invalid_quantity"),
      );
      await f.product({ minimumOrderQuantity: "0.126000000000000001" });
      await assert.rejects(
        f.change(
          "update",
          { version: r.draft.version, quantity: "0.126" },
          r.items[0].id,
        ),
        code("invalid_quantity"),
      );
      await f.product({ active: false });
      await assert.rejects(
        f.change(
          "update",
          { version: r.draft.version, quantity: "1" },
          r.items[0].id,
        ),
        code("not_found"),
      );
      assert.deepEqual(await f.read(), r);
      r = await f.change("remove", { version: r.draft.version }, r.items[0].id);
      await f.state("SUBMITTED");
      await assert.rejects(f.read(), code("not_found"));
      await assert.rejects(f.add(r.draft.version), code("conflict"));
    },
  );
  test(
    provider +
      ": item/header and item/delete races have one winner and a shared reloadable version",
    options,
    async (t) => {
      const f = await fixture(t, provider);
      const results = await Promise.allSettled([
        f.add(),
        f.service.update(
          f.ca,
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
      let r = await f.read();
      if (!r.items.length) r = await f.add(r.draft.version);
      const races = await Promise.allSettled([
        f.change(
          "update",
          { version: r.draft.version, quantity: "0.5" },
          r.items[0].id,
        ),
        f.change("remove", { version: r.draft.version }, r.items[0].id),
      ]);
      assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        races.find((r) => r.status === "rejected").reason.code,
        "conflict",
      );
      const loaded = await f.read();
      assert.notEqual(loaded.draft.version, r.draft.version);
      assert.deepEqual(
        (await f.service.find(f.ca, f.draft.id)).draft,
        loaded.draft,
      );
    },
  );
  test(
    provider +
      ": live account/session expiry and audit uncertainty preserve atomic item/header state",
    options,
    async (t) => {
      const f = await fixture(t, provider);
      await f.setUser({ status: "SUSPENDED" }, 2);
      await assert.rejects(f.add(), (e) =>
        ["forbidden", "invalid_proof"].includes(e.code),
      );
      await f.setUser({ status: "ACTIVE" }, 2);
      f.clock.value = Date.parse(f.ca.accessExpiresAt);
      await assert.rejects(f.add(), code("invalid_proof"));
      f.clock.value = Date.now();
      f.ca = await f.actor();
      const failing = createOrderDrafts(f.repo, async () => {
        throw Error("PRIVATE_AUDIT");
      });
      await assert.rejects(
        failing.changeItem(
          f.ca,
          f.draft.id,
          undefined,
          "add",
          {
            version: f.draft.version,
            productId: f.data.products[2].id,
            quantity: "0.25",
          },
          randomUUID(),
        ),
        code("unavailable"),
      );
      const r = await f.read();
      assert.equal(r.items[0].quantity, "0.25");
      assert.notEqual(r.draft.version, f.draft.version);
      await assert.rejects(f.add(), code("conflict"));
    },
  );
  test(
    provider +
      ": actual HTTP item contract, authorization, quantity error and shared conflict response",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        server = createApp({
          sessions: f.auth,
          orderDrafts: f.service,
          logger: () => {},
        }).listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(
        () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(r);
          }),
      );
      const base =
          "http://127.0.0.1:" +
          server.address().port +
          "/api/v1/order-drafts/" +
          f.draft.id +
          "/items",
        token = (await f.login(2)).accessToken;
      const send = (suffix = "", method = "GET", body, proof = token) =>
        fetch(base + suffix, {
          method,
          headers: {
            authorization: "Bearer " + proof,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      assert.equal((await send("", "GET", undefined, "bad")).status, 401);
      assert.equal(
        (await send("", "GET", undefined, (await f.login(3)).accessToken))
          .status,
        404,
      );
      let res = await send("", "POST", {
        version: f.draft.version,
        productId: f.data.products[2].id,
        quantity: "0",
      });
      assert.equal(res.status, 400);
      assert.equal(
        (await res.json()).error.code,
        "INVALID_ORDER_ITEM_QUANTITY",
      );
      res = await send("", "POST", {
        version: f.draft.version,
        productId: f.data.products[2].id,
        quantity: "0.5",
      });
      assert.equal(res.status, 201);
      assert.equal(res.headers.get("cache-control"), "no-store");
      let envelope = await res.json();
      assert.equal(envelope.success, true);
      assert.ok(envelope.requestId);
      let r = envelope.data;
      assert.deepEqual((await (await send()).json()).data, r);
      res = await send("/" + r.items[0].id, "PATCH", {
        version: r.draft.version,
        quantity: "0.75",
      });
      assert.equal(res.status, 200);
      r = (await res.json()).data;
      res = await send("/" + r.items[0].id, "DELETE", {
        version: f.draft.version,
      });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).error.code, "ORDER_DRAFT_CONFLICT");
      res = await send("/" + r.items[0].id, "DELETE", {
        version: r.draft.version,
      });
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).data.items, []);
    },
  );
}
test("JSON failures before/after publication never split item changes from draft version", async (t) => {
  for (const kind of ["add", "update", "remove"])
    for (const after of [false, true]) {
      const f = await fixture(t, "json");
      let r = await f.read();
      if (kind !== "add") r = await f.add();
      const repo = createJsonOrderDrafts(f.security, f.now, {
        writeOrders: async (rows) => {
          if (after) await f.security.store.replace("orders", rows);
          throw Error("PRIVATE_IO");
        },
      });
      const service = createOrderDrafts(repo, f.record);
      await assert.rejects(
        service.changeItem(
          f.ca,
          f.draft.id,
          r.items[0]?.id,
          kind,
          {
            version: r.draft.version,
            ...(kind === "add" ? { productId: f.data.products[2].id } : {}),
            ...(kind !== "remove" ? { quantity: "0.5" } : {}),
          },
          randomUUID(),
        ),
        code("unavailable"),
      );
      const current = await f.read();
      if (!after) assert.deepEqual(current, r);
      else {
        assert.notEqual(current.draft.version, r.draft.version);
        assert.equal(current.items.length, kind === "remove" ? 0 : 1);
      }
    }
});
test("JSON expiry after product reads refuses publication; unknown private item data is retained", async (t) => {
  const f = await fixture(t, "json"),
    read = f.security.store.read.bind(f.security.store);
  f.security.store.read = async (name) => {
    const rows = await read(name);
    if (name === "customer_product_access")
      f.clock.value = Date.parse(f.ca.accessExpiresAt);
    return rows;
  };
  await assert.rejects(f.add(), code("invalid_proof"));
  f.security.store.read = read;
  f.clock.value = Date.now();
  assert.deepEqual(await f.read(), { draft: f.draft, items: [] });
  const r = await f.add(),
    path = join(f.directory, "orders.json"),
    raw = JSON.parse(await fs.readFile(path, "utf8"));
  raw.find((o) => o.id === f.draft.id).items[0].snapshot = { private: "KEEP" };
  await fs.writeFile(path, JSON.stringify(raw));
  const before = await fs.readFile(path, "utf8");
  await assert.rejects(
    f.change("remove", { version: r.draft.version }, r.items[0].id),
    code("unavailable"),
  );
  await assert.rejects(
    f.service.update(
      f.ca,
      f.draft.id,
      { version: r.draft.version, deliveryAddressId: null },
      randomUUID(),
    ),
    code("unavailable"),
  );
  assert.equal(await fs.readFile(path, "utf8"), before);
});
test(
  "SQL statement failure rolls back line and header together; protected line evidence survives",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, "postgresql"),
      r = await f.add();
    await f.pool.query(
      "CREATE FUNCTION fail_item_header() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''private failure''; END'; CREATE TRIGGER item_header_failure BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION fail_item_header()",
    );
    await assert.rejects(
      f.change(
        "update",
        { version: r.draft.version, quantity: "0.5" },
        r.items[0].id,
      ),
      code("unavailable"),
    );
    await assert.rejects(
      f.change("remove", { version: r.draft.version }, r.items[0].id),
      code("unavailable"),
    );
    await assert.rejects(
      f.add(r.draft.version, "1", f.data.products[0].id),
      code("unavailable"),
    );
    assert.deepEqual(await f.read(), r);
    await f.pool.query("DROP TRIGGER item_header_failure ON orders");
    await f.pool.query(
      "UPDATE order_items SET item_snapshot=$1::jsonb WHERE id=$2",
      [JSON.stringify({ private: "KEEP" }), r.items[0].id],
    );
    await assert.rejects(
      f.change("remove", { version: r.draft.version }, r.items[0].id),
      code("conflict"),
    );
    assert.deepEqual(
      (
        await f.pool.query(
          "SELECT item_snapshot FROM order_items WHERE id=$1",
          [r.items[0].id],
        )
      ).rows[0].item_snapshot,
      { private: "KEEP" },
    );
  },
);
