import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createApp } from "../dist/app.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createJsonCompanyProfiles } from "../dist/infrastructure/json/company-profiles.js";
import { createPostgresCompanyProfiles } from "../dist/infrastructure/postgres-company-profiles.js";
import { createJsonDeliveryAddresses } from "../dist/infrastructure/json/delivery-addresses.js";
import { createPostgresDeliveryAddresses } from "../dist/infrastructure/postgres-delivery-addresses.js";
import { createJsonInvoices } from "../dist/infrastructure/json/invoices.js";
import { createPostgresInvoices } from "../dist/infrastructure/postgres-invoices.js";
import { createJsonSalesAssignments } from "../dist/infrastructure/json/sales-assignments.js";
import { createPostgresSalesAssignments } from "../dist/infrastructure/postgres-sales-assignments.js";
import { createCompanyProfiles } from "../dist/services/company-profiles.js";
import { createDeliveryAddresses } from "../dist/services/delivery-addresses.js";
import { createInvoiceQueries } from "../dist/services/invoices.js";

// Compose real routers and providers around persisted credentials/sessions. These
// tests deliberately retain tokens across changes instead of logging in again.
async function fixture(t, provider) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.update = async (collection, id, patch) => {
    if (provider === "json")
      await f.security.run(async () => {
        const rows = await f.security.store.read(collection);
        await f.security.store.replace(
          collection,
          rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        );
      });
    else {
      const columns = {
        companyId: "company_id",
        status: "status",
        role: "role",
        mustChangePassword: "must_change_password",
        passwordHash: "password_hash",
      };
      assert.ok(["users", "companies"].includes(collection));
      for (const [key, value] of Object.entries(patch)) {
        assert.ok(Object.hasOwn(columns, key));
        await f.pool.query(
          `UPDATE ${collection} SET ${columns[key]}=$1 WHERE id=$2`,
          [value, id],
        );
      }
    }
  };
  const repositories =
    provider === "json"
      ? createJsonRepositories(f.security.store)
      : createPostgresRepositories(f.pool);
  const invoices =
    provider === "json"
      ? createJsonInvoices(f.security)
      : createPostgresInvoices(f.pool);
  f.invoices = [];
  f.addresses = [];
  for (const c of f.data.companies) {
    const order = {
      ...f.data.orders.find((o) => o.companyId === c.id),
      status: "CONFIRMED",
      integrationStatus: "SUCCESS",
      erpOrderReference: randomUUID(),
    };
    const address = {
      id: randomUUID(),
      companyId: c.id,
      label: `Delivery ${c.id}`,
      address: { line1: `Synthetic ${c.id}` },
      contactName: null,
      contactPhone: null,
      active: true,
      isDefault: true,
    };
    f.addresses.push(address);
    if (provider === "json") await f.update("orders", order.id, order);
    else {
      await f.pool.query(
        "UPDATE companies SET erp_customer_reference=$1 WHERE id=$2",
        [c.erpCustomerReference, c.id],
      );
      await f.pool.query(
        "INSERT INTO orders(id,company_id,created_by_user_id,created_at,order_status,integration_status,erp_order_reference,order_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          order.id,
          c.id,
          order.createdByUserId,
          order.createdAt,
          order.status,
          order.integrationStatus,
          order.erpOrderReference,
          { private: "PRIVATE_AUTHORIZATION_SNAPSHOT" },
        ],
      );
      await f.pool.query(
        "INSERT INTO delivery_addresses(id,company_id,label,address,active,is_default) VALUES($1,$2,$3,$4,true,true)",
        [address.id, c.id, address.label, address.address],
      );
    }
    const invoice = {
      id: randomUUID(),
      companyId: c.id,
      orderId: order.id,
      erpInvoiceReference: `PRIVATE_ERP_${c.id}`,
      invoiceNumber: `SYN-${c.id}`,
      status: "available",
      amount: "100.00",
      currency: "AED",
      documentReference: `mock-invoice:${order.erpOrderReference}`,
      issuedAt: new Date(f.now()).toISOString(),
      syncedAt: new Date(f.now()).toISOString(),
    };
    await invoices.save(await invoices.link(order.id), invoice);
    f.invoices.push(invoice);
  }
  if (provider === "json")
    await writeFile(
      join(f.directory, "delivery_addresses.json"),
      JSON.stringify(f.addresses),
    );
  f.assign = async (companyId, patch = {}) => {
    const row = {
      id: randomUUID(),
      companyId,
      salesStaffUserId: f.data.users[1].id,
      assignedByUserId: f.data.users[0].id,
      isPrimary: true,
      active: true,
      createdAt: new Date(f.now() - 1000).toISOString(),
      endedAt: null,
      ...patch,
    };
    if (provider === "json")
      await writeFile(
        join(f.directory, "customer_sales_assignments.json"),
        JSON.stringify([row]),
      );
    else {
      await f.pool.query("DELETE FROM customer_sales_assignments");
      await f.pool.query(
        "INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        Object.values(row),
      );
    }
  };
  f.logs = [];
  f.tokens = [];
  f.loginToken = async (index) => {
    const login = await f.login(index);
    f.tokens.push(login.accessToken, login.refreshToken);
    return login.accessToken;
  };
  const server = createApp({
    sessions: f.auth,
    companyRepositories: repositories,
    invoices: createInvoiceQueries(invoices, repositories.companies),
    companyProfiles: createCompanyProfiles(
      provider === "json"
        ? createJsonCompanyProfiles(f.security, f.now)
        : createPostgresCompanyProfiles(f.pool, f.now),
    ),
    deliveryAddresses: createDeliveryAddresses(
      provider === "json"
        ? createJsonDeliveryAddresses(f.security, f.now)
        : createPostgresDeliveryAddresses(f.pool, f.now),
    ),
    salesAssignments:
      provider === "json"
        ? createJsonSalesAssignments(f.security, f.now)
        : createPostgresSalesAssignments(f.pool, f.now),
    logger: (level, event) => f.logs.push({ level, event }),
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  f.responses = [];
  f.get = async (path, token, status = 200) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v1${path}`,
      {
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "x-role": "INTERNAL_ADMIN",
          "x-company-id": f.data.companies[1].id,
          "x-user-id": f.data.users[0].id,
          "x-assigned": "true",
        },
      },
    );
    const body = await response.json();
    f.responses.push(body);
    assert.equal(response.status, status, path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    if (status !== 200) {
      assert.equal(body.success, false, path);
      assert.equal(body.data, undefined, path);
      assert.ok(body.error.code, path);
    }
    return body;
  };
  f.privateCheck = () => {
    const serialized = JSON.stringify({ responses: f.responses, logs: f.logs });
    for (const secret of [
      ...f.tokens,
      f.passwordHash,
      "passwordHash",
      "credentialFingerprint",
      "refreshTokenHash",
      "PRIVATE_AUTHORIZATION_SNAPSHOT",
      "PRIVATE_ERP_",
      "mock-invoice:",
    ])
      assert.equal(serialized.includes(secret), false, "private value leaked");
  };
  return f;
}

for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set disposable B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
  };
  test(
    `${provider}: one customer token follows current membership and role across composed HTTP routers`,
    options,
    async (t) => {
      const f = await fixture(t, provider),
        [a, b] = f.data.companies;
      const index = f.data.users.findIndex(
        (u) => u.companyId === a.id && u.role === "CUSTOMER_ADMIN",
      );
      const token = await f.loginToken(index);
      for (const [own, foreign] of [
        [a, b],
        [b, a],
      ]) {
        await f.update("users", f.data.users[index].id, { companyId: own.id });
        assert.equal(
          (await f.get("/company-profile", token)).data.company.id,
          own.id,
        );
        const addresses = (await f.get("/delivery-addresses", token)).data;
        assert.equal(addresses.companyId, own.id);
        assert.deepEqual(
          addresses.items.map((r) => r.id),
          [f.addresses.find((r) => r.companyId === own.id).id],
        );
        const invoice = f.invoices.find((r) => r.companyId === own.id);
        const otherInvoice = f.invoices.find((r) => r.companyId === foreign.id);
        const page = (await f.get("/invoices?limit=1", token)).data;
        assert.equal(page.total, 1);
        assert.deepEqual(
          page.items.map((r) => r.id),
          [invoice.id],
        );
        await f.get(`/invoices/${invoice.id}`, token);
        const denied = await f.get(`/invoices/${otherInvoice.id}`, token, 404);
        assert.deepEqual(
          denied.error,
          (await f.get(`/invoices/${randomUUID()}`, token, 404)).error,
        );
        for (const collection of ["orders", "users"]) {
          const page = (
            await f.get(`/companies/${own.id}/${collection}`, token)
          ).data;
          assert.ok(page.total > 0);
          assert.ok(page.items.every((r) => r.companyId === own.id));
        }
        for (const suffix of ["", "/orders", "/users"])
          await f.get(`/companies/${foreign.id}${suffix}`, token, 404);
        for (const path of [
          "/company-profile",
          "/delivery-addresses",
          "/invoices",
        ])
          await f.get(`${path}?companyId=${foreign.id}`, token, 400);
      }
      await f.update("users", f.data.users[index].id, {
        role: "CUSTOMER_USER",
      });
      await f.get(`/companies/${b.id}/users`, token, 403);
      await f.get("/company-profile", token);
      await f.get("/invoices", token);
      f.privateCheck();
    },
  );

  test(
    `${provider}: restriction, lifecycle, credentials, expiry and revocation deny the same token on every configured read surface`,
    options,
    async (t) => {
      const f = await fixture(t, provider),
        company = f.data.companies[0];
      const index = f.data.users.findIndex(
        (u) => u.companyId === company.id && u.role === "CUSTOMER_ADMIN",
      );
      const token = await f.loginToken(index),
        userId = f.data.users[index].id;
      const paths = [
        "/company-profile",
        "/delivery-addresses",
        "/invoices",
        `/invoices/${f.invoices[0].id}`,
        `/companies/${company.id}`,
        `/companies/${company.id}/orders`,
        `/companies/${company.id}/users`,
        `/companies/${company.id}/catalog`,
      ];
      const all = async (status, proof = token) => {
        for (const path of paths) await f.get(path, proof, status);
      };
      await all(200);
      await all(401, "invalid");
      await f.update("users", userId, { mustChangePassword: true });
      await all(403);
      await f.update("users", userId, { mustChangePassword: false });
      await all(200);
      await f.update("users", userId, { status: "DEACTIVATED" });
      await all(401);
      await f.update("users", userId, { status: "ACTIVE" });
      await f.update("companies", company.id, { status: "SUSPENDED" });
      await all(401);
      await f.update("companies", company.id, { status: "ACTIVE" });
      await f.update("users", userId, {
        passwordHash: "scrypt-v1$" + "a".repeat(32) + "$" + "b".repeat(64),
      });
      await all(401);
      await f.update("users", userId, { passwordHash: f.passwordHash });
      await all(200);
      f.clock.value += 931000;
      await all(401);
      f.clock.value -= 931000;
      await all(200);
      await f.auth.revoke(token, randomUUID());
      await all(401);
      f.privateCheck();
    },
  );

  test(
    `${provider}: Sales assignment changes apply together to list totals, profile and delivery reads without issuing a new token`,
    options,
    async (t) => {
      const f = await fixture(t, provider),
        [a, b] = f.data.companies;
      const token = await f.loginToken(1);
      for (const own of [a, b]) {
        await f.assign(own.id);
        const foreign = own === a ? b : a;
        const page = (await f.get("/sales/companies?limit=1", token)).data;
        assert.equal(page.total, 1);
        assert.deepEqual(
          page.items.map((r) => r.id),
          [own.id],
        );
        for (const suffix of ["profile", "delivery-addresses"]) {
          await f.get(`/companies/${own.id}/${suffix}`, token);
          await f.get(`/companies/${foreign.id}/${suffix}`, token, 403);
        }
        for (const patch of [
          { active: false, endedAt: new Date(f.now()).toISOString() },
          { createdAt: new Date(f.now() + 60000).toISOString() },
        ]) {
          await f.assign(own.id, patch);
          const empty = (await f.get("/sales/companies?offset=10", token)).data;
          assert.equal(empty.total, 0);
          assert.deepEqual(empty.items, []);
          for (const suffix of ["profile", "delivery-addresses"])
            await f.get(`/companies/${own.id}/${suffix}`, token, 403);
        }
      }
      await f.get(`/companies/${b.id}/orders`, token, 403);
      await f.get("/invoices", token, 403);
      f.privateCheck();
    },
  );
}
