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
        "?unsupported=rice",
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
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
  };
  test(
    provider +
      ": catalog filters precede tenant counts/pages and preserve exact stock, prices and deterministic ties",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        a = (await f.login(2)).accessToken,
        b = (await f.login(4)).accessToken;
      const id = (n) =>
        "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
      const names = [
        "Twin 100%_\\ O'Reilly Café 😀",
        "Twin 100%_\\ O'Reilly Café 😀",
        "Other CAFÉ",
        "Twin foreign",
        "Twin hidden",
        "Unknown",
        "Legacy",
      ];
      const products = names.map((name, i) => ({
        id: id(901 + i),
        sku: "FILTER-" + (901 + i),
        name,
        sellingUom: "Case",
        minimumOrderQuantity: "0.125",
        active: i !== 4,
        defaultPrice: {
          amount: "12.3400",
          currency: "AED",
          validFrom: null,
          validTo: null,
        },
        ...(i === 6
          ? {}
          : {
              metadata: {
                category: i === 5 ? null : "Filter",
                brand: i === 5 ? null : "Brand",
                availableQuantity:
                  i === 0 ? "0.000000000000000001" : i === 1 ? "0.000" : null,
              },
            }),
      }));
      const access = products.flatMap((p, i) =>
        f.data.companies.flatMap((c, ci) =>
          (ci === 0 ? i !== 3 : i === 1 || i === 3)
            ? [{ companyId: c.id, productId: p.id, eligible: true }]
            : [],
        ),
      );
      const custom = {
        companyId: f.data.companies[0].id,
        productId: id(901),
        price: {
          amount: "9007199254740993.0001",
          currency: "AED",
          validFrom: null,
          validTo: null,
        },
      };
      if (provider === "json") {
        await f.store.replace("products", [
          ...(await f.store.read("products")),
          ...products,
        ]);
        await f.store.replace("customer_product_access", [
          ...(await f.store.read("customer_product_access")),
          ...access,
        ]);
        await f.store.replace("customer_product_prices", [
          ...(await f.store.read("customer_product_prices")),
          custom,
        ]);
      } else {
        for (const p of products)
          await f.pool.query(
            "INSERT INTO products(id,erp_product_reference,sku,name,selling_uom,minimum_order_quantity,active,default_price,currency,category,brand,available_quantity) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
            [
              p.id,
              p.sku,
              p.name,
              p.sellingUom,
              p.minimumOrderQuantity,
              p.active,
              p.defaultPrice.amount,
              "AED",
              p.metadata?.category ?? null,
              p.metadata?.brand ?? null,
              p.metadata?.availableQuantity ?? null,
            ],
          );
        for (const r of access)
          await f.pool.query(
            "INSERT INTO customer_product_access(id,company_id,product_id,eligible) VALUES($1,$2,$3,$4)",
            [randomUUID(), r.companyId, r.productId, r.eligible],
          );
        await f.pool.query(
          "INSERT INTO customer_product_prices(id,company_id,product_id,amount,currency) VALUES($1,$2,$3,$4,$5)",
          [
            randomUUID(),
            custom.companyId,
            custom.productId,
            custom.price.amount,
            "AED",
          ],
        );
      }
      const query = (values, token = a) =>
        f.get("?" + new URLSearchParams(values), token).then(data);
      const ids = (page) => page.items.map((p) => p.id);
      assert.deepEqual(ids(await query({ name: "  tWIN  " })), [
        id(901),
        id(902),
      ]);
      assert.deepEqual(ids(await query({ name: "twin" }, b)), [
        id(902),
        id(904),
      ]);
      assert.equal((await query({ name: "foreign" })).total, 0);
      const page = await query({ name: "twin", offset: "1", limit: "1" });
      assert.deepEqual(ids(page), [id(902)]);
      assert.equal(page.total, 2);
      assert.equal(page.offset, 1);
      assert.equal(page.limit, 1);
      assert.equal(
        (await query({ name: "twin", offset: "2", limit: "100" })).total,
        2,
      );
      assert.equal(
        (await query({ name: "twin", offset: "100000", limit: "100" })).items
          .length,
        0,
      );
      assert.deepEqual(
        ids(
          await query({
            sku: "901",
            category: " FILTER ",
            brand: "bRAND",
            availability: "available",
          }),
        ),
        [id(901)],
      );
      const exact = (await query({ sku: "901" })).items[0];
      assert.equal(exact.availableQuantity, "0.000000000000000001");
      assert.equal(exact.minimumOrderQuantity, "0.125");
      assert.equal(exact.price.amount, "9007199254740993.0001");
      assert.deepEqual(
        ids(await query({ category: "filter", availability: "unavailable" })),
        [id(902)],
      );
      assert.deepEqual(
        ids(await query({ category: "filter", availability: "unknown" })),
        [id(903)],
      );
      assert.deepEqual(
        ids(await query({ sku: "FILTER-", availability: "unknown" })),
        [id(903), id(906), id(907)],
      );
      assert.deepEqual(ids(await query({ search: "filter-903" })), [id(903)]);
      assert.deepEqual(ids(await query({ search: "twin", sku: "902" })), [
        id(902),
      ]);
      for (const name of ["%", "_", "\\", "O'Reilly", "café", "😀"])
        assert.deepEqual(ids(await query({ name })), [id(901), id(902)], name);
      assert.deepEqual(ids(await query({ name: "CAFÉ" })), [id(903)]);
      assert.equal((await query({ category: "filt" })).total, 0);
      assert.equal((await query({ brand: "missing" })).total, 0);
      assert.equal(
        (await query({ name: "twin", availability: "unknown" })).total,
        0,
      );
      assert.deepEqual(
        await query({
          name: " ",
          sku: "",
          category: " ",
          brand: "",
          search: "",
          availability: "all",
        }),
        await query({}),
      );
      const cu = (await f.login(3)).accessToken;
      assert.deepEqual(
        await query({ name: "twin" }, cu),
        await query({ name: "twin" }),
      );
    },
  );
  test(
    provider +
      ": catalog rejects malformed filters/page bounds before any company or catalog query",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        token = (await f.login(2)).accessToken;
      let calls = 0;
      const blocked = {
        ...f.repositories,
        companies: {
          findById: async () => {
            calls++;
            throw new Error("PRIVATE");
          },
        },
        catalog: {
          listEligible: async () => {
            calls++;
            throw new Error("PRIVATE");
          },
        },
      };
      const url = await serve(
        t,
        createApp({
          sessions: f.auth,
          companyRepositories: blocked,
          logger: () => {},
        }),
      );
      const paths = [
        "name=a&name=b",
        "name[x]=a",
        "sku=a&sku=b",
        "category=a&category=b",
        "brand=a&brand=b",
        "availability=all&availability=all",
        "availability=",
        "availability=AVAILABLE",
        "availability=low",
        "offset=100001",
        "offset=1.5",
        "offset=01",
        "limit=101",
        "limit=0",
        "offset=9007199254740992",
        "offset=1e2",
        "search=" + encodeURIComponent("a".repeat(129)),
        "name=%00",
        "name=%0A",
        "category=%7F",
        "brand=%C2%85",
        "companyId=foreign",
        "sort=recommended",
      ];
      for (const query of paths) {
        const response = await fetch(
          url + "/api/v1/catalog/products?" + query,
          { headers: { authorization: "Bearer " + token } },
        );
        assert.equal(response.status, 400, query);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(
          (await response.json()).error.code,
          "INVALID_COMPANY_QUERY",
        );
      }
      assert.equal(calls, 0);
      assert.equal(
        (await f.get("/" + randomUUID() + "?name=a", token)).status,
        400,
      );
      assert.equal(
        (
          await fetch(
            f.url +
              "/api/v1/companies/" +
              f.data.companies[0].id +
              "/catalog?name=a",
            { headers: { authorization: "Bearer " + token } },
          )
        ).status,
        400,
      );
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
