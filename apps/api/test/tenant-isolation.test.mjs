import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createAuthorization } from "../dist/services/authorization.js";
import { createTenantQueries } from "../dist/services/tenant-queries.js";
import { createApp } from "../dist/app.js";
async function fixture(t, provider = "json") {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  if (provider === "postgresql") {
    for (const c of f.data.companies)
      await f.pool.query(
        "UPDATE companies SET erp_customer_reference=$1 WHERE id=$2",
        [c.erpCustomerReference, c.id],
      );
    for (const r of f.data.products)
      await f.pool.query(
        "INSERT INTO products(id,erp_product_reference,sku,name,selling_uom,minimum_order_quantity,active,default_price,currency,price_valid_from,price_valid_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          r.id,
          r.erpProductReference,
          r.sku,
          r.name,
          r.sellingUom,
          r.minimumOrderQuantity,
          r.active,
          r.defaultPrice?.amount ?? null,
          r.defaultPrice?.currency ?? null,
          r.defaultPrice?.validFrom ?? null,
          r.defaultPrice?.validTo ?? null,
        ],
      );
    for (const r of f.data.customer_product_access)
      await f.pool.query(
        "INSERT INTO customer_product_access(id,company_id,product_id,eligible) VALUES($1,$2,$3,$4)",
        [randomUUID(), r.companyId, r.productId, r.eligible],
      );
    for (const r of f.data.customer_product_prices)
      await f.pool.query(
        "INSERT INTO customer_product_prices(id,company_id,product_id,amount,currency,valid_from,valid_to) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          r.companyId,
          r.productId,
          r.price.amount,
          r.price.currency,
          r.price.validFrom,
          r.price.validTo,
        ],
      );
    for (const r of f.data.orders)
      await f.pool.query(
        `INSERT INTO orders(id,company_id,order_number,created_by_user_id,created_at,order_status,integration_status,order_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,'{"private":"PRIVATE_SNAPSHOT"}')`,
        [
          r.id,
          r.companyId,
          r.orderNumber,
          r.createdByUserId,
          r.createdAt,
          r.status,
          r.integrationStatus,
        ],
      );
  }
  f.repositories =
    provider === "json"
      ? createJsonRepositories(f.security.store, () => new Date(f.now()))
      : createPostgresRepositories(f.pool, () => new Date(f.now()));
  f.customer = (company, role = "CUSTOMER_ADMIN") =>
    f.data.users.findIndex((u) => u.companyId === company && u.role === role);
  f.actor = async (index) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(index)).accessToken,
      "profile.read",
    );
  f.setCompany = async (id, status) => {
    if (provider === "json")
      await f.security.run(async () => {
        const rows = await f.security.store.read("companies");
        await f.security.store.replace(
          "companies",
          rows.map((r) => (r.id === id ? { ...r, status } : r)),
        );
      });
    else
      await f.pool.query("UPDATE companies SET status=$1 WHERE id=$2", [
        status,
        id,
      ]);
  };
  return f;
}
async function serve(t, f, logs = [], repositories = f.repositories) {
  const server = createApp({
    sessions: f.auth,
    companyRepositories: repositories,
    logger: (level, event) => logs.push({ level, event }),
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return "http://127.0.0.1:" + server.address().port + "/api/v1/companies/";
}
const get = (url, token, extra = {}) =>
  fetch(url, {
    headers: {
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...extra,
    },
  });
const data = async (response) => {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()).data;
};
const notFound = (e) => e.code === "not_found";
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
  };
  test(
    provider +
      ": both customer roles see only their company lists/counts/details, eligible prices and public allowlists",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        logs = [],
        url = await serve(t, f, logs);
      for (const [companyIndex, c] of f.data.companies.entries())
        for (const role of ["CUSTOMER_ADMIN", "CUSTOMER_USER"]) {
          const login = await f.login(f.customer(c.id, role)),
            base = url + c.id;
          const profile = await data(await get(base, login.accessToken));
          assert.equal(profile.company.id, c.id);
          assert.deepEqual(
            Object.keys(profile.company).sort(),
            [
              "id",
              "legalName",
              "tradeName",
              "status",
              "erpCustomerReference",
            ].sort(),
          );
          const orders = f.data.orders.filter((r) => r.companyId === c.id),
            first = await data(
              await get(base + "/orders?limit=1", login.accessToken),
            );
          assert.equal(first.total, orders.length);
          assert.equal(first.items.length, 1);
          assert.equal(first.items[0].companyId, c.id);
          const empty = await data(
            await get(base + "/orders?offset=99", login.accessToken),
          );
          assert.equal(empty.items.length, 0);
          assert.equal(empty.total, orders.length);
          const order = await data(
            await get(base + "/orders/" + orders[0].id, login.accessToken),
          );
          assert.equal(order.order.companyId, c.id);
          assert.equal("createdByUserId" in order.order, false);
          assert.deepEqual(
            Object.keys(order.order).sort(),
            [
              "id",
              "companyId",
              "orderNumber",
              "createdAt",
              "status",
              "integrationStatus",
            ].sort(),
          );
          const products = await data(
            await get(base + "/catalog", login.accessToken),
          );
          assert.equal(products.total, companyIndex === 0 ? 3 : 2);
          const p = await data(
            await get(
              base + "/catalog/" + f.data.products[0].id,
              login.accessToken,
            ),
          );
          assert.equal(
            p.product.price.amount,
            companyIndex === 0 ? "20.00" : "22.50",
          );
          assert.equal(typeof p.product.minimumOrderQuantity, "string");
          const directory = await get(base + "/users", login.accessToken);
          if (role === "CUSTOMER_USER") assert.equal(directory.status, 403);
          else {
            const users = await data(directory);
            assert.equal(users.total, 2);
            assert.ok(users.items.every((u) => u.companyId === c.id));
            const user = await data(
              await get(
                base +
                  "/users/" +
                  f.data.users[f.customer(c.id, "CUSTOMER_USER")].id,
                login.accessToken,
              ),
            );
            assert.equal(user.user.companyId, c.id);
            assert.deepEqual(
              Object.keys(user.user).sort(),
              ["id", "companyId", "displayName", "role", "status"].sort(),
            );
          }
          const serialized = JSON.stringify({
            profile,
            first,
            order,
            products,
            p,
            logs,
          });
          for (const secret of [
            login.accessToken,
            login.refreshToken,
            f.passwordHash,
            "passwordHash",
            "credentialFingerprint",
            "PRIVATE_SNAPSHOT",
            "internalNotes",
            "rawErpError",
          ])
            assert.equal(serialized.includes(secret), false);
        }
    },
  );
  test(
    provider +
      ": foreign company/object/parent selectors and client scope claims never cross the tenant boundary",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        url = await serve(t, f),
        [a, b] = f.data.companies;
      for (const role of ["CUSTOMER_ADMIN", "CUSTOMER_USER"]) {
        const login = await f.login(f.customer(a.id, role));
        for (const suffix of [
          "",
          "/catalog",
          "/catalog/" + f.data.products[0].id,
          "/orders",
          "/orders/" + f.data.orders.find((o) => o.companyId === b.id).id,
        ]) {
          const response = await get(url + b.id + suffix, login.accessToken, {
            "x-company-id": b.id,
            "x-role": "INTERNAL_ADMIN",
          });
          assert.equal(response.status, 404);
          assert.equal(
            (await response.json()).error.code,
            "RESOURCE_NOT_FOUND",
          );
        }
        const foreignOrder = f.data.orders.find((o) => o.companyId === b.id),
          foreign = await get(
            url + a.id + "/orders/" + foreignOrder.id,
            login.accessToken,
          ),
          missing = await get(
            url + a.id + "/orders/" + randomUUID(),
            login.accessToken,
          );
        assert.equal(foreign.status, 404);
        assert.equal(missing.status, 404);
        assert.deepEqual(
          (await foreign.json()).error,
          (await missing.json()).error,
        );
        assert.equal(
          (
            await get(
              url + a.id + "/orders?companyId=" + b.id,
              login.accessToken,
            )
          ).status,
          400,
        );
        if (role === "CUSTOMER_ADMIN") {
          const otherUser = f.data.users[f.customer(b.id, "CUSTOMER_USER")];
          assert.equal(
            (
              await get(
                url + a.id + "/users/" + otherUser.id,
                login.accessToken,
              )
            ).status,
            404,
          );
          assert.equal(
            (
              await get(
                url + b.id + "/users/" + otherUser.id,
                login.accessToken,
              )
            ).status,
            404,
          );
        }
      }
      const bLogin = await f.login(f.customer(b.id));
      assert.equal(
        (
          await get(
            url + b.id + "/catalog/" + f.data.products[1].id,
            bLogin.accessToken,
          )
        ).status,
        404,
      );
      assert.equal(
        (await get(url + b.id + "/catalog/" + randomUUID(), bLogin.accessToken))
          .status,
        404,
      );
    },
  );
  test(
    provider +
      ": current membership/lifecycle is revalidated; Internal Admin retains historical company reads and Sales awaits assignment checks",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        url = await serve(t, f),
        [a, b] = f.data.companies,
        index = f.customer(a.id),
        login = await f.login(index),
        admin = await f.login(),
        sales = await f.login(1);
      await f.setCompany(a.id, "SUSPENDED");
      assert.equal(
        (await get(url + a.id + "/orders", login.accessToken)).status,
        401,
      );
      assert.equal(
        (await get(url + a.id + "/orders", admin.accessToken)).status,
        200,
      );
      assert.equal(
        (await get(url + b.id + "/orders", admin.accessToken)).status,
        200,
      );
      assert.equal(
        (await get(url + randomUUID(), admin.accessToken)).status,
        404,
      );
      assert.equal(
        (
          await get(url + b.id + "/orders", sales.accessToken, {
            "x-company-id": b.id,
            "x-assigned": "true",
          })
        ).status,
        403,
      );
      await f.setCompany(a.id, "ACTIVE");
      if (provider === "json") await f.setUser({ companyId: b.id }, index);
      else
        await f.pool.query("UPDATE users SET company_id=$1 WHERE id=$2", [
          b.id,
          login.user.id,
        ]);
      assert.equal(
        (await get(url + a.id + "/orders", login.accessToken)).status,
        404,
      );
      assert.equal(
        (await data(await get(url + b.id, login.accessToken))).company.id,
        b.id,
      );
      assert.equal(
        (await get(url + b.id.toUpperCase() + "/orders", login.accessToken))
          .status,
        200,
      );
      await f.setUser({ status: "DEACTIVATED" }, index);
      assert.equal(
        (await get(url + b.id + "/orders", login.accessToken)).status,
        401,
      );
    },
  );
  test(
    provider +
      ": invalid query and provider failure are controlled without another-company or fallback data",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        logs = [],
        url = await serve(t, f, logs),
        company = f.data.companies[0].id,
        login = await f.login(f.customer(company)),
        base = url + company;
      for (const suffix of [
        "/orders?limit=0",
        "/orders?limit=101",
        "/orders?offset=-1",
        "/orders?offset=9007199254740992",
        "/orders?limit=1&limit=2",
        "/catalog?role=INTERNAL_ADMIN",
        "/users?companyId=" + randomUUID(),
        "/orders/not-a-uuid",
      ])
        assert.equal((await get(base + suffix, login.accessToken)).status, 400);
      assert.equal(
        (
          await get(base + "/orders", undefined, {
            "x-role": "INTERNAL_ADMIN",
            "x-company-id": company,
          })
        ).status,
        401,
      );
      if (provider === "json")
        await fs.writeFile(
          join(f.directory, "customer_product_prices.json"),
          "PRIVATE_STORAGE_FAILURE",
        );
      else
        await f.pool.query(
          "ALTER TABLE customer_product_prices RENAME TO unavailable_prices",
        );
      const response = await get(base + "/catalog", login.accessToken);
      assert.equal(response.status, 503);
      const failure = await response.json();
      assert.equal(failure.error.code, "COMPANY_QUERY_UNAVAILABLE");
      const serialized = JSON.stringify({ failure, logs });
      assert.equal(serialized.includes("PRIVATE"), false);
      assert.equal(serialized.includes("unavailable_prices"), false);
      assert.equal(serialized.includes(login.accessToken), false);
    },
  );
}
test("service capability and company checks precede data reads; corrupt parent/child and mixed-tenant pages never serialize", async (t) => {
  const f = await fixture(t),
    [a, b] = f.data.companies,
    actor = await f.actor(f.customer(a.id)),
    queries = createTenantQueries(f.repositories);
  await assert.rejects(
    queries.getCompany({ ...actor }, a.id),
    (e) => e.name === "AuthorizationError",
  );
  let reads = 0;
  const wrapped = {
    ...f.repositories,
    companies: {
      findById: async (scope) => {
        reads++;
        return f.repositories.companies.findById(scope);
      },
    },
  };
  const guarded = createTenantQueries(wrapped);
  await assert.rejects(guarded.listOrders(actor, b.id), notFound);
  assert.equal(reads, 0);
  const sales = await f.actor(1);
  await assert.rejects(
    guarded.listProducts(sales, a.id),
    (e) => e.name === "AuthorizationError",
  );
  assert.equal(reads, 0);
  await assert.rejects(
    guarded.listOrders(actor, a.id, { offset: 0, limit: 0 }),
    (e) => e.code === "invalid_input",
  );
  assert.equal(reads, 0);
  const order = f.data.orders[0],
    foreignOrder = { ...order, companyId: b.id };
  const customer = f.data.users[f.customer(a.id)];
  const corrupt = createTenantQueries({
    ...f.repositories,
    orders: {
      findById: async () => foreignOrder,
      list: async () => ({ items: [foreignOrder], total: 1 }),
    },
    users: {
      findCustomerById: async () => ({ ...customer, companyId: b.id }),
      listCustomers: async () => ({
        items: [{ ...customer, companyId: b.id }],
        total: 1,
      }),
    },
  });
  await assert.rejects(corrupt.getOrder(actor, a.id, order.id), notFound);
  await assert.rejects(corrupt.getUser(actor, a.id, customer.id), notFound);
  await assert.rejects(
    corrupt.listOrders(actor, a.id),
    (e) => e.code === "unavailable",
  );
  await assert.rejects(
    corrupt.listUsers(actor, a.id),
    (e) => e.code === "unavailable",
  );
});
test(
  "actual PostgreSQL and JSON public scoped outputs are identical for both companies",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const json = await fixture(t),
      sql = await fixture(t, "postgresql");
    for (const company of json.data.companies) {
      const index = json.customer(company.id),
        ja = await json.actor(index),
        sa = await sql.actor(index);
      const jq = createTenantQueries(json.repositories),
        sq = createTenantQueries(sql.repositories);
      for (const method of [
        "getCompany",
        "listProducts",
        "listUsers",
        "listOrders",
      ])
        assert.deepEqual(
          await jq[method](ja, company.id),
          await sq[method](sa, company.id),
        );
    }
  },
);
