import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createApp } from "../dist/app.js";
import { createApp as mockApp } from "../../mock-erp/dist/app.js";
import { createMockCustomerCatalogSource } from "../dist/infrastructure/mock-customer-catalog-adapter.js";
import { createCatalogSync } from "../dist/services/catalog-sync.js";
import { createJsonCatalogCache } from "../dist/infrastructure/json/catalog-cache.js";
import { createPostgresCatalogCache } from "../dist/infrastructure/postgres-catalog-cache.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { JsonFileStore } from "../dist/infrastructure/json/store.js";
import { seedJson } from "../dist/demo/seed.js";
import { createAuthorization } from "../dist/services/authorization.js";
import { createTenantQueries } from "../dist/services/tenant-queries.js";

async function serve(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return "http://127.0.0.1:" + server.address().port;
}
async function fixture(t, provider) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  let cache;
  if (provider === "json") {
    const directory = join(f.directory, "b2b_demo_catalog");
    await seedJson(directory, {
      mode: "seed",
      confirmTarget: "b2b_demo_catalog",
    });
    f.store = new JsonFileStore(directory);
    cache = createJsonCatalogCache(directory, "b2b_demo_catalog", true);
    f.repositories = createJsonRepositories(f.store, () => new Date(f.now()));
  } else {
    for (const c of f.data.companies)
      await f.pool.query(
        "UPDATE companies SET erp_customer_reference=$1 WHERE id=$2",
        [c.erpCustomerReference, c.id],
      );
    cache = createPostgresCatalogCache(f.pool);
    f.repositories = createPostgresRepositories(
      f.pool,
      () => new Date(f.now()),
    );
  }
  const source = createMockCustomerCatalogSource({
    baseUrl: (await serve(t, mockApp())) + "/mock-erp/v1/",
    timeoutMs: 5000,
  });
  const sync = createCatalogSync(source, cache, randomUUID);
  await sync.synchronize(new AbortController().signal);
  f.url = await serve(
    t,
    createApp({
      sessions: f.auth,
      companyRepositories: f.repositories,
      logger: () => {},
    }),
  );
  f.get = (path, token, headers = {}) =>
    fetch(f.url + "/api/v1/catalog/products" + path, {
      headers: {
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...headers,
      },
    });
  f.actor = async (index) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(index)).accessToken,
      "catalog.read",
    );
  return f;
}
async function data(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()).data;
}
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
  };
  test(
    provider +
      ": real Mock catalog -> cache -> customer HTTP preserves eligibility, prices, metadata and exact values",
    options,
    async (t) => {
      const f = await fixture(t, provider);
      for (const index of [2, 3, 4, 5]) {
        const token = (await f.login(index)).accessToken;
        const page = await data(await f.get("", token));
        assert.equal(page.offset, 0);
        assert.equal(page.limit, 20);
        assert.equal(page.total, index < 4 ? 5 : 4);
        const rice = page.items.find((p) => p.sku === "DEMO-RICE-BAG");
        assert.equal(rice.price.amount, index < 4 ? "27.50" : "30.00");
        assert.equal(rice.price.currency, "AED");
        assert.equal(rice.category, "Demo Pantry");
        assert.equal(rice.brand, "Demo Staples");
        const unknown = page.items.find((p) => p.sku === "DEMO-UNKNOWN-CASE");
        assert.equal(unknown.availableQuantity, null);
        assert.equal(unknown.price, null);
        assert.equal(unknown.minimumOrderQuantity, "0.125");
        assert.equal(unknown.sellingUom, "Case");
        if (index < 4)
          assert.ok(
            page.items.some((p) =>
              /^0(?:\.0+)?$/.test(p.availableQuantity ?? ""),
            ),
          );
        for (const product of page.items) {
          assert.deepEqual(
            Object.keys(product).sort(),
            [
              "id",
              "sku",
              "name",
              "sellingUom",
              "minimumOrderQuantity",
              "price",
              "category",
              "brand",
              "availableQuantity",
            ].sort(),
          );
          assert.deepEqual(
            (await data(await f.get("/" + product.id, token))).product,
            product,
          );
        }
        const paged = await data(await f.get("?offset=1&limit=1", token));
        assert.equal(paged.items.length, 1);
        assert.equal(paged.total, page.total);
        assert.equal(paged.offset, 1);
        assert.equal(paged.limit, 1);
        assert.equal(
          (await data(await f.get("?offset=999&limit=1", token))).items.length,
          0,
        );
      }
      const a = (await f.login(2)).accessToken,
        b = (await f.login(4)).accessToken;
      const pageA = await data(await f.get("", a)),
        pageB = await data(await f.get("", b));
      const inaccessible = pageA.items.find(
        (p) => !pageB.items.some((q) => q.id === p.id),
      );
      assert.ok(inaccessible);
      const foreign = await f.get("/" + inaccessible.id, b),
        missing = await f.get("/" + randomUUID(), b);
      assert.equal(foreign.status, 404);
      assert.equal(missing.status, 404);
      assert.deepEqual(
        (await foreign.json()).error,
        (await missing.json()).error,
      );
      assert.equal((await f.get("/not-an-id", a)).status, 400);
    },
  );
  test(
    provider +
      ": rejects company/role selectors and noncustomer actors; uses current session/company state",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        token = (await f.login(2)).accessToken;
      for (const query of [
        "?companyId=" + f.data.companies[1].id,
        "?customerId=DEMO-C002",
        "?role=INTERNAL_ADMIN",
        "?name=rice",
        "?limit=0",
        "?offset=-1",
        "?limit=1&limit=2",
        "?offset=9007199254740992",
      ])
        assert.equal((await f.get(query, token)).status, 400, query);
      assert.equal((await f.get("", undefined)).status, 401);
      for (const index of [0, 1])
        assert.equal(
          (await f.get("", (await f.login(index)).accessToken)).status,
          403,
        );
      const clean = await data(await f.get("", token));
      assert.deepEqual(
        await data(
          await f.get("", token, {
            "x-company-id": f.data.companies[1].id,
            "x-role": "INTERNAL_ADMIN",
          }),
        ),
        clean,
      );
      const queries = createTenantQueries(f.repositories);
      await assert.rejects(
        queries.listOwnProducts({
          role: "CUSTOMER_ADMIN",
          companyId: f.data.companies[0].id,
        }),
        (e) => e.name === "AuthorizationError",
      );
      const company = f.data.companies[0].id;
      if (provider === "json") {
        for (const store of [f.security.store, f.store]) {
          await store.replace(
            "companies",
            (await store.read("companies")).map((c) =>
              c.id === company ? { ...c, status: "SUSPENDED" } : c,
            ),
          );
        }
      } else
        await f.pool.query(
          "UPDATE companies SET status='SUSPENDED' WHERE id=$1",
          [company],
        );
      assert.equal((await f.get("", token)).status, 401);
    },
  );
  test(
    provider +
      ": expired and future overrides fall back to current default, then null; inactive products stay hidden",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        token = (await f.login(2)).accessToken;
      const page = await data(await f.get("", token)),
        rice = page.items.find((p) => p.sku === "DEMO-RICE-BAG");
      const at = new Date(f.now()).toISOString(),
        future = new Date(f.now() + 60000).toISOString();
      async function change(from, to, defaultTo, active = true) {
        if (provider === "json") {
          await f.store.replace(
            "customer_product_prices",
            (await f.store.read("customer_product_prices")).map((p) =>
              p.productId === rice.id
                ? { ...p, price: { ...p.price, validFrom: from, validTo: to } }
                : p,
            ),
          );
          await f.store.replace(
            "products",
            (await f.store.read("products")).map((p) =>
              p.id === rice.id
                ? {
                    ...p,
                    active,
                    defaultPrice: { ...p.defaultPrice, validTo: defaultTo },
                  }
                : p,
            ),
          );
        } else {
          await f.pool.query(
            "UPDATE customer_product_prices SET valid_from=$1,valid_to=$2 WHERE product_id=$3",
            [from, to, rice.id],
          );
          await f.pool.query(
            "UPDATE products SET price_valid_to=$1,active=$2 WHERE id=$3",
            [defaultTo, active, rice.id],
          );
        }
      }
      await change(null, at, null);
      assert.equal(
        (await data(await f.get("/" + rice.id, token))).product.price.amount,
        "30.00",
      );
      await change(future, null, null);
      assert.equal(
        (await data(await f.get("/" + rice.id, token))).product.price.amount,
        "30.00",
      );
      await change(future, null, at);
      assert.equal(
        (await data(await f.get("/" + rice.id, token))).product.price,
        null,
      );
      await change(future, null, at, false);
      assert.equal((await f.get("/" + rice.id, token)).status, 404);
      assert.equal((await data(await f.get("", token))).total, page.total - 1);
    },
  );
}
test("customer catalog source refuses mismatched/duplicate rows, non-JSON, redirects and cancellation without publishing", async (t) => {
  const real = createMockCustomerCatalogSource({
    baseUrl: (await serve(t, mockApp())) + "/mock-erp/v1/",
    timeoutMs: 5000,
  });
  const snapshot = await real.readSnapshot(new AbortController().signal);
  assert.equal(snapshot.products.length, 6);
  for (const mode of [
    "wrong-customer",
    "duplicate",
    "non-json",
    "redirect",
    "changed-total",
  ]) {
    const app = mockApp();
    const proxy = express();
    proxy.get("/mock-erp/v1/master-data", app);
    proxy.get("/mock-erp/v1/catalog", async (request, response) => {
      if (mode === "redirect") return response.redirect("/elsewhere");
      if (mode === "non-json") return response.send("PRIVATE");
      const original = await fetch(
        new URL(
          "catalog?customerId=" + request.query.customerId + "&limit=100",
          realBase,
        ),
      );
      const body = await original.json();
      if (mode === "wrong-customer") body.customerId = "FOREIGN";
      if (mode === "duplicate") body.items[1] = body.items[0];
      if (mode === "changed-total") body.total++;
      response.json(body);
    });
    const realBase = (await serve(t, mockApp())) + "/mock-erp/v1/";
    let published = false;
    const source = createMockCustomerCatalogSource({
      baseUrl: (await serve(t, proxy)) + "/mock-erp/v1/",
      timeoutMs: 5000,
    });
    await assert.rejects(
      createCatalogSync(
        source,
        {
          refresh: async () => {
            published = true;
          },
        },
        randomUUID,
      ).synchronize(new AbortController().signal),
    );
    assert.equal(published, false);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(real.readSnapshot(controller.signal));
});
