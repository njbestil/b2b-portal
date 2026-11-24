import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createJsonCompanyProfiles } from "../dist/infrastructure/json/company-profiles.js";
import { createPostgresCompanyProfiles } from "../dist/infrastructure/postgres-company-profiles.js";
import { createCompanyProfiles } from "../dist/services/company-profiles.js";
import { createApp } from "../dist/app.js";

for (const provider of ["json", "postgresql"]) {
  test(
    `${provider}: assigned Sales reads bounded company details and loses access on reassignment`,
    {
      skip:
        provider === "postgresql" &&
        !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
          ? "PostgreSQL URL required"
          : false,
    },
    async (t) => {
      const f = await authFixture(t, provider);
      for (let i = 0; i < f.data.users.length; i++)
        await f.setUser({ mustChangePassword: false }, i);
      const company = f.data.companies[0],
        other = f.data.companies[1],
        staff = f.data.users[1];
      const assignment = {
        id: randomUUID(),
        companyId: company.id,
        salesStaffUserId: staff.id,
        assignedByUserId: f.data.users[0].id,
        isPrimary: true,
        active: true,
        createdAt: new Date(f.now() - 1000).toISOString(),
        endedAt: null,
      };
      async function setAssigned(active) {
        if (provider === "json")
          await f.security.run(() =>
            fs.writeFile(
              join(f.directory, "customer_sales_assignments.json"),
              JSON.stringify(active ? [assignment] : []),
            ),
          );
        else if (active)
          await f.pool.query(
            "INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at,ended_at) VALUES($1,$2,$3,$4,true,true,$5,NULL)",
            [
              assignment.id,
              assignment.companyId,
              assignment.salesStaffUserId,
              assignment.assignedByUserId,
              assignment.createdAt,
            ],
          );
        else
          await f.pool.query(
            "DELETE FROM customer_sales_assignments WHERE id=$1",
            [assignment.id],
          );
      }
      if (provider === "postgresql") {
        for (const c of f.data.companies)
          await f.pool.query(
            "UPDATE companies SET erp_customer_reference=$1 WHERE id=$2",
            [c.erpCustomerReference, c.id],
          );
        for (const p of f.data.products)
          await f.pool.query(
            "INSERT INTO products(id,erp_product_reference,sku,name,selling_uom,minimum_order_quantity,active,default_price,currency,price_valid_from,price_valid_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
            [
              p.id,
              p.erpProductReference,
              p.sku,
              p.name,
              p.sellingUom,
              p.minimumOrderQuantity,
              p.active,
              p.defaultPrice?.amount ?? null,
              p.defaultPrice?.currency ?? null,
              p.defaultPrice?.validFrom ?? null,
              p.defaultPrice?.validTo ?? null,
            ],
          );
        for (const a of f.data.customer_product_access)
          await f.pool.query(
            "INSERT INTO customer_product_access(id,company_id,product_id,eligible) VALUES($1,$2,$3,$4)",
            [randomUUID(), a.companyId, a.productId, a.eligible],
          );
        for (const p of f.data.customer_product_prices)
          await f.pool.query(
            "INSERT INTO customer_product_prices(id,company_id,product_id,amount,currency,valid_from,valid_to) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              randomUUID(),
              p.companyId,
              p.productId,
              p.price.amount,
              p.price.currency,
              p.price.validFrom,
              p.price.validTo,
            ],
          );
        for (const order of f.data.orders)
          await f.pool.query(
            "INSERT INTO orders(id,company_id,created_by_user_id,order_number,created_at,order_status,integration_status) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              order.id,
              order.companyId,
              order.createdByUserId,
              order.orderNumber,
              order.createdAt,
              order.status,
              order.integrationStatus,
            ],
          );
      }
      await setAssigned(true);
      const repositories =
        provider === "json"
          ? createJsonRepositories(f.security.store, () => new Date(f.now()))
          : createPostgresRepositories(f.pool, () => new Date(f.now()));
      const profiles = createCompanyProfiles(
        provider === "json"
          ? createJsonCompanyProfiles(f.security, f.now)
          : createPostgresCompanyProfiles(f.pool, f.now),
      );
      let revokeDuringRead = false,
        expireDuringRead = false;
      const wrapped = {
        ...repositories,
        catalog: {
          ...repositories.catalog,
          async listEligible(...args) {
            const result = await repositories.catalog.listEligible(...args);
            if (revokeDuringRead) {
              revokeDuringRead = false;
              await setAssigned(false);
            }
            if (expireDuringRead) f.clock.value += 24 * 60 * 60 * 1000;
            return result;
          },
        },
      };
      const server = createApp({
        sessions: f.auth,
        companyProfiles: profiles,
        companyRepositories: wrapped,
        logger: () => {},
      }).listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(
        () =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          }),
      );
      const root = `http://127.0.0.1:${server.address().port}/api/v1/sales/companies`,
        token = (await f.login(1)).accessToken,
        customerToken = (await f.login(2)).accessToken;
      const get = (path, bearer = token) =>
        fetch(root + path, { headers: { authorization: `Bearer ${bearer}` } });
      assert.equal((await get(`/${other.id}`)).status, 403);
      assert.equal((await get(`/${company.id}`, customerToken)).status, 403);
      assert.equal(
        (await get(`/${company.id}/users?companyId=${other.id}`)).status,
        400,
      );
      assert.equal((await get(`/${company.id}/catalog?limit=0`)).status, 400);
      const companyResponse = await get(`/${company.id}`);
      assert.equal(companyResponse.status, 200);
      assert.equal(companyResponse.headers.get("cache-control"), "no-store");
      assert.equal((await companyResponse.json()).data.company.id, company.id);
      const users = (await (await get(`/${company.id}/users`)).json()).data;
      assert.ok(
        users.items.length > 0 &&
          users.items.every((u) => u.companyId === company.id),
      );
      assert.equal(JSON.stringify(users).includes("password"), false);
      const catalog = (await (await get(`/${company.id}/catalog`)).json()).data;
      assert.ok(catalog.items.length > 0);
      const expected = await repositories.catalog.listEligible(
        { companyId: company.id },
        { offset: 0, limit: 20 },
      );
      assert.deepEqual(
        catalog.items.map((p) => p.price),
        expected.items.map((p) => p.price),
      );
      const orders = (await (await get(`/${company.id}/orders`)).json()).data;
      assert.ok(
        orders.items.every(
          (o) => o.companyId === company.id && o.status !== "DRAFT",
        ),
      );
      assert.equal(JSON.stringify(orders).includes("snapshot"), false);
      revokeDuringRead = true;
      assert.equal((await get(`/${company.id}/catalog`)).status, 403);
      assert.equal((await get(`/${company.id}/users`)).status, 403);
      assignment.companyId = other.id;
      await setAssigned(true);
      const otherCatalog = (await (await get(`/${other.id}/catalog`)).json())
        .data;
      const firstProduct = f.data.products[0].id;
      assert.notEqual(
        catalog.items.find((p) => p.id === firstProduct).price.amount,
        otherCatalog.items.find((p) => p.id === firstProduct).price.amount,
      );
      assert.equal(
        otherCatalog.items.some((p) => p.id === f.data.products[1].id),
        false,
      );
      assert.equal((await get(`/${company.id}/orders`)).status, 403);
      expireDuringRead = true;
      assert.equal((await get(`/${other.id}/catalog`)).status, 401);
    },
  );
}
