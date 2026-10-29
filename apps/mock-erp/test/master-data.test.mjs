import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { createMasterData } from "../dist/master-data.js";

const collections = [
  "customers",
  "products",
  "pricing",
  "eligibility",
  "inventory",
  "credit",
];

function unique(values) {
  assert.equal(new Set(values).size, values.length);
}

test("all six datasets are populated with unique, consistent ERP references", () => {
  const data = createMasterData();
  assert.deepEqual(Object.keys(data), collections);
  for (const collection of collections) assert.ok(data[collection].length > 0);
  unique(data.customers.map((row) => row.customerId));
  unique(data.products.map((row) => row.productId));
  unique(data.products.map((row) => row.sku));
  unique(data.pricing.map((row) => `${row.customerId}:${row.productId}`));
  unique(data.eligibility.map((row) => `${row.customerId}:${row.productId}`));
  unique(data.inventory.map((row) => row.productId));
  unique(data.credit.map((row) => row.customerId));

  const customerIds = new Set(data.customers.map((row) => row.customerId));
  const productIds = new Set(data.products.map((row) => row.productId));
  for (const row of [...data.pricing, ...data.eligibility, ...data.inventory]) {
    assert.ok(productIds.has(row.productId));
  }
  for (const row of [...data.pricing, ...data.eligibility, ...data.credit]) {
    if (row.customerId !== null) assert.ok(customerIds.has(row.customerId));
  }
  assert.deepEqual(
    new Set(data.inventory.map((row) => row.productId)),
    productIds,
  );
  assert.deepEqual(
    new Set(data.credit.map((row) => row.customerId)),
    customerIds,
  );
  assert.equal(data.eligibility.length, customerIds.size * productIds.size);

  for (const row of data.products) {
    assert.match(row.minimumOrderQuantity, /^\d+(\.\d+)?$/);
    assert.ok(Number(row.minimumOrderQuantity) > 0);
  }
  for (const row of data.pricing) {
    assert.match(row.unitPrice, /^\d+\.\d{2}$/);
    assert.equal(row.currency, "AED");
    assert.equal(new Date(row.effectiveFrom).toISOString(), row.effectiveFrom);
    assert.equal(row.effectiveTo, null);
  }
  for (const row of data.inventory) {
    assert.match(row.availableQuantity, /^\d+(\.\d+)?$/);
  }
  for (const row of data.credit) {
    assert.match(row.creditLimit, /^\d+\.\d{2}$/);
    assert.match(row.outstandingBalance, /^\d+\.\d{2}$/);
    assert.equal(row.currency, "AED");
  }
});

test("seed covers customer-specific commercial data and boundary fixtures", () => {
  const { customers, products, pricing, eligibility, inventory, credit } =
    createMasterData();
  assert.equal(customers.length, 2);
  assert.ok(customers.every((row) => row.active && row.paymentTerms));
  const override = pricing.find((row) => row.customerId !== null);
  const defaultPrice = pricing.find(
    (row) => row.customerId === null && row.productId === override.productId,
  );
  assert.notEqual(override.unitPrice, defaultPrice.unitPrice);
  assert.ok(!pricing.some((row) => row.customerId === "DEMO-C002"));
  const excluded = eligibility.find((row) => !row.eligible);
  assert.ok(
    eligibility.some(
      (row) =>
        row.productId === excluded.productId &&
        row.customerId !== excluded.customerId &&
        row.eligible,
    ),
  );
  assert.ok(products.some((row) => !row.active));
  assert.ok(
    products.some(
      (row) =>
        row.active && !pricing.some((p) => p.productId === row.productId),
    ),
  );
  assert.ok(
    products.some(
      (row) => row.sellingUom === "KG" && row.minimumOrderQuantity === "0.5",
    ),
  );
  assert.ok(inventory.some((row) => row.availableQuantity === "0"));
  assert.ok(inventory.some((row) => row.availableQuantity.includes(".")));
  assert.deepEqual(
    new Set(credit.map((row) => row.status)),
    new Set(["clear", "hold"]),
  );
});

test("seed is deterministic and each complete nested snapshot is detached", () => {
  const expected = createMasterData();
  const modified = createMasterData();
  assert.deepEqual(modified, expected);
  for (const collection of collections) {
    const field = Object.keys(modified[collection][0])[0];
    modified[collection][0][field] = "modified";
    modified[collection].pop();
  }
  assert.deepEqual(createMasterData(), expected);
});

async function startApp(t) {
  const server = createApp().listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP snapshot is read-only, repeatable and identical for fresh applications", async (t) => {
  const baseUrl = await startApp(t);
  const path = "/mock-erp/v1/master-data";
  const expected = createMasterData();
  const response = await fetch(baseUrl + path);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const body = await response.json();
  assert.deepEqual(body, expected);
  body.customers[0].name = "client mutation";

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const write = await fetch(baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(write.status, 404);
    await write.text();
  }
  assert.deepEqual(await (await fetch(baseUrl + path)).json(), expected);
  const secondBaseUrl = await startApp(t);
  assert.deepEqual(await (await fetch(secondBaseUrl + path)).json(), expected);
  const head = await fetch(baseUrl + path, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.equal(await head.text(), "");

  assert.deepEqual(await (await fetch(baseUrl + "/")).json(), {
    service: "b2b-portal-mock-erp",
  });
  const health = await fetch(baseUrl + "/mock-erp/v1/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.deepEqual(await health.json(), { status: "up" });
});
