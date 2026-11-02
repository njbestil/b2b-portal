import assert from "node:assert/strict";
import test from "node:test";
import { catalogFixture } from "./catalog-fixture.mjs";
import {
  CatalogClient,
  customerCatalogAdapter,
  defaultQuery,
} from "../../src/features/catalog/api.ts";
test("Web catalog transport uses the real customer API and Mock-populated JSON cache", async (t) => {
  const fixture = await catalogFixture(t);
  const session = await fixture.client();
  const client = new CatalogClient(
    customerCatalogAdapter((path, signal) => session.read(path, signal)),
  );
  const signal = new AbortController().signal;
  const all = await client.list(defaultQuery, signal);
  assert.equal(all.total, 5);
  const rice = all.items.find((p) => p.sku === "DEMO-RICE-BAG");
  assert.equal(rice.price.amount, "27.50");
  const unknown = all.items.find((p) => p.sku === "DEMO-UNKNOWN-CASE");
  assert.equal(unknown.availableQuantity, null);
  assert.equal(unknown.minimumOrderQuantity, "0.125");
  assert.equal(unknown.price, null);
  assert.deepEqual(await client.detail(rice.id, signal), rice);
  const second = await client.list(
    { ...defaultQuery, offset: 1, limit: 1 },
    signal,
  );
  assert.equal(second.total, all.total);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].id, all.items[1].id);
  const other = await fixture.client(4);
  const otherClient = new CatalogClient(
    customerCatalogAdapter((path, signal) => other.read(path, signal)),
  );
  const otherPage = await otherClient.list(defaultQuery, signal);
  assert.equal(otherPage.total, 4);
  assert.equal(
    otherPage.items.find((p) => p.sku === rice.sku).price.amount,
    "30.00",
  );
  const privateItem = all.items.find(
    (p) => !otherPage.items.some((other) => other.id === p.id),
  );
  await assert.rejects(otherClient.detail(privateItem.id, signal), {
    code: "not-found",
  });
  await session.logout();
  await assert.rejects(client.list(defaultQuery, signal), {
    code: "unavailable",
  });
});

test("real filter API applies combined matching and availability before counts and paging", async (t) => {
  const f = await catalogFixture(t),
    session = await f.client();
  const client = new CatalogClient(
    customerCatalogAdapter((path, signal) => session.read(path, signal)),
  );
  const signal = new AbortController().signal;
  const rice = await client.list(
    {
      ...defaultQuery,
      search: "rice",
      category: "DEMO PANTRY",
      brand: "demo staples",
      availability: "available",
    },
    signal,
  );
  assert.equal(rice.total, 1);
  assert.equal(rice.items[0].sku, "DEMO-RICE-BAG");
  const unknown = await client.list(
    { ...defaultQuery, availability: "unknown" },
    signal,
  );
  assert.equal(unknown.total, 1);
  assert.equal(unknown.items[0].availableQuantity, null);
  const zero = await client.list(
    { ...defaultQuery, availability: "unavailable" },
    signal,
  );
  assert.equal(zero.total, 1);
  assert.equal(zero.items[0].availableQuantity, "0");
  const literal = await client.list({ ...defaultQuery, search: "%_" }, signal);
  assert.equal(literal.total, 0);
  const end = await client.list(
    { ...defaultQuery, search: "DEMO-RICE-BAG", offset: 1, limit: 1 },
    signal,
  );
  assert.equal(end.total, 1);
  assert.deepEqual(end.items, []);
});
