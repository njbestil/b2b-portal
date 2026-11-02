import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { lookupCatalog } from "../dist/catalog.js";
import { createApp } from "../dist/app.js";
import { createMasterData } from "../dist/master-data.js";

const lookup = (extra = {}) =>
  lookupCatalog({ customerId: "DEMO-C001", ...extra });
test("catalog returns exact raw company inputs, including ineligible and unknown fixtures", () => {
  const first = lookup();
  const rice = first.items.find((p) => p.productId === "DEMO-P001");
  assert.deepEqual(
    rice.prices.map((p) => p.unitPrice),
    ["30.00", "27.50"],
  );
  assert.equal(rice.sellingUom, "Bag");
  assert.equal(rice.minimumOrderQuantity, "1");
  assert.equal(rice.availableQuantity, "100");
  const other = lookup({ customerId: "DEMO-C002" });
  assert.deepEqual(
    other.items
      .find((p) => p.productId === "DEMO-P001")
      .prices.map((p) => p.unitPrice),
    ["30.00"],
  );
  assert.equal(
    other.items.find((p) => p.productId === "DEMO-P002").eligibility.eligible,
    false,
  );
  const unknown = lookup({ availability: "unknown" }).items;
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].availableQuantity, null);
  assert.deepEqual(unknown[0].prices, []);
  assert.equal(unknown[0].minimumOrderQuantity, "0.125");
  assert.equal(unknown[0].sellingUom, "Case");
  assert.equal(
    first.items.find((p) => p.productId === "DEMO-P003").minimumOrderQuantity,
    "0.5",
  );
  assert.equal(
    first.items.find((p) => p.productId === "DEMO-P003").availableQuantity,
    "25.5",
  );
});
test("combined filters and bounded pagination are stable and do not change source snapshots", () => {
  const seed = createMasterData();
  const filtered = lookup({
    name: "RICE",
    sku: "rice-bag",
    category: "pantry",
    brand: "staples",
    availability: "available",
  });
  assert.deepEqual(
    filtered.items.map((p) => p.productId),
    ["DEMO-P001"],
  );
  const all = lookup();
  const pages = all.items.map(
    (_, i) => lookup({ offset: String(i), limit: "1" }).items[0],
  );
  assert.deepEqual(pages, all.items);
  assert.equal(lookup({ offset: "99999" }).items.length, 0);
  assert.equal(
    lookup({ availability: "unavailable" }).items[0].productId,
    "DEMO-P002",
  );
  const expected = structuredClone(all);
  all.items[0].prices.push({ unitPrice: "modified" });
  assert.deepEqual(lookup(), expected);
  assert.deepEqual(createMasterData(), seed);
  for (const extra of [
    { limit: "0" },
    { limit: "101" },
    { limit: "1.5" },
    { offset: "-1" },
    { offset: "100001" },
    { name: ["x"] },
    { brand: {} },
    { unknown: "x" },
    { availability: "yes" },
    { customerId: "missing" },
    { name: "" },
    { sku: "x".repeat(129) },
  ]) {
    assert.throws(
      () => lookup(extra),
      (error) => error.code === "INVALID_CATALOG_QUERY",
    );
  }
});
test("HTTP lookup validates repeated query parameters, is read-only and has no-store", async (t) => {
  const server = createApp().listen(0, "127.0.0.1");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  await once(server, "listening");
  const url =
    "http://127.0.0.1:" +
    server.address().port +
    "/mock-erp/v1/catalog?customerId=DEMO-C001";
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const expected = await response.json();
  assert.deepEqual(await (await fetch(url)).json(), expected);
  assert.equal((await fetch(url + "&limit=1&limit=2")).status, 400);
  assert.equal((await fetch(url, { method: "POST" })).status, 404);
});
