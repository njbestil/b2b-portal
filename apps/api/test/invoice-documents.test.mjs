import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { authFixture, barrier } from "./helpers/auth-fixture.mjs";
import { createApp } from "../dist/app.js";
import { createApp as createMock } from "../../mock-erp/dist/app.js";
import { createJsonInvoices } from "../dist/infrastructure/json/invoices.js";
import { createPostgresInvoices } from "../dist/infrastructure/postgres-invoices.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createJsonCompanyProfiles } from "../dist/infrastructure/json/company-profiles.js";
import { createPostgresCompanyProfiles } from "../dist/infrastructure/postgres-company-profiles.js";
import {
  createInvoiceSync,
  createInvoiceQueries,
} from "../dist/services/invoices.js";
import { createMockInvoiceSource } from "../dist/infrastructure/mock-invoice-adapter.js";
import { createMockInvoiceDocuments } from "../dist/infrastructure/mock-invoice-documents.js";
import { createInvoiceDocuments } from "../dist/services/invoice-documents.js";
async function serve(t, app) {
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, provider, transform = (source) => source) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.repo =
    provider === "json"
      ? createJsonInvoices(f.security)
      : createPostgresInvoices(f.pool);
  f.repositories =
    provider === "json"
      ? createJsonRepositories(f.security.store)
      : createPostgresRepositories(f.pool);
  const base = await serve(t, createMock());
  f.erpBaseUrl = base + "/mock-erp/v1/";
  f.source = createMockInvoiceSource({
    baseUrl: base + "/mock-erp/v1/",
    timeoutMs: 1000,
  });
  f.sync = createInvoiceSync(f.source, f.repo, randomUUID, () =>
    new Date(f.now()).toISOString(),
  );
  f.orders = [];
  for (const company of f.data.companies) {
    const order = {
      ...f.data.orders.find((o) => o.companyId === company.id),
      status: "CONFIRMED",
      integrationStatus: "SUCCESS",
    };
    const res = await fetch(base + "/mock-erp/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
        "X-Mock-ERP-Scenario": "completed",
      },
      body: JSON.stringify({
        portalOrderId: order.id,
        customerId: company.erpCustomerReference,
        items: [{ productId: "DEMO-P001", quantity: "2" }],
      }),
    });
    assert.equal(res.status, 201);
    order.erpOrderReference = (await res.json()).erpOrderId;
    f.orders.push(order);
    if (provider === "json") {
      const rows = await f.security.store.read("orders");
      await f.security.store.replace(
        "orders",
        rows.map((r) => (r.id === order.id ? order : r)),
      );
    } else {
      await f.pool.query(
        "UPDATE companies SET erp_customer_reference=$1 WHERE id=$2",
        [company.erpCustomerReference, company.id],
      );
      await f.pool.query(
        "INSERT INTO orders(id,company_id,order_number,created_by_user_id,created_at,order_status,integration_status,erp_order_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          order.id,
          order.companyId,
          order.orderNumber,
          order.createdByUserId,
          order.createdAt,
          order.status,
          order.integrationStatus,
          order.erpOrderReference,
        ],
      );
    }
  }
  f.profiles =
    provider === "json"
      ? createJsonCompanyProfiles(f.security, f.now)
      : createPostgresCompanyProfiles(f.pool, f.now);
  f.documents = createInvoiceDocuments(
    f.repo,
    f.profiles,
    transform(
      createMockInvoiceDocuments({ baseUrl: f.erpBaseUrl, timeoutMs: 1000 }),
    ),
  );
  f.url = await serve(
    t,
    createApp({
      sessions: f.auth,
      invoiceDocuments: f.documents,
      invoices: createInvoiceQueries(f.repo, f.repositories.companies),
      logger: () => {},
    }),
  );
  f.get = async (path, index) =>
    fetch(f.url + path, {
      headers:
        index === undefined
          ? {}
          : { Authorization: "Bearer " + (await f.login(index)).accessToken },
    });
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
    `${provider}: real Mock document is company-scoped, read-only, bounded and synthetic`,
    options,
    async (t) => {
      const f = await fixture(t, provider);
      for (const order of f.orders)
        await f.sync.synchronize(order.id, new AbortController().signal);
      const buyer = f.data.users.findIndex(
        (u) =>
          u.role === "CUSTOMER_ADMIN" && u.companyId === f.orders[0].companyId,
      );
      const other = f.data.users.findIndex(
        (u) =>
          u.role === "CUSTOMER_ADMIN" && u.companyId === f.orders[1].companyId,
      );
      const invoice = (
          await f.repo.list(f.orders[0].companyId, { offset: 0, limit: 20 })
        ).items[0],
        path = `/api/v1/invoices/${invoice.id}/document`;
      const before = await f.repo.find(invoice.companyId, invoice.id);
      const response = await f.get(path, buyer),
        text = await response.text();
      assert.equal(response.status, 200);
      assert.match(
        text,
        /^SYNTHETIC DEMO INVOICE REFERENCE\nNOT A TAX INVOICE - NO FINANCIAL AUTHORITY/,
      );
      assert.ok(Buffer.byteLength(text) <= 4096);
      assert.equal(
        response.headers.get("content-length"),
        String(Buffer.byteLength(text)),
      );
      assert.equal(
        response.headers.get("content-disposition"),
        `attachment; filename="mock-invoice-${invoice.id}.txt"`,
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(
        JSON.parse(text.slice(text.indexOf("{"))).portalOrderId,
        invoice.orderId,
      );
      assert.deepEqual(
        await f.repo.find(invoice.companyId, invoice.id),
        before,
      );
      assert.equal((await f.get(path, other)).status, 404);
      assert.equal(
        (await f.get(`/api/v1/invoices/${randomUUID()}/document`, other))
          .status,
        404,
      );
      assert.equal((await f.get(path)).status, 401);
      assert.equal(
        (await f.get(path + "?companyId=" + invoice.companyId, buyer)).status,
        400,
      );
      for (const role of ["INTERNAL_ADMIN", "SALES_STAFF"])
        assert.equal(
          (
            await f.get(
              path,
              f.data.users.findIndex((u) => u.role === role),
            )
          ).status,
          403,
        );
      await f.setUser({ mustChangePassword: true }, buyer);
      assert.equal((await f.get(path, buyer)).status, 403);
    },
  );
  test(
    `${provider}: authority revoked during remote document retrieval prevents publication`,
    options,
    async (t) => {
      const entered = barrier(),
        release = barrier();
      const f = await fixture(t, provider, (source) => ({
        async read(...args) {
          const bytes = await source.read(...args);
          entered.resolve();
          await release.promise;
          return bytes;
        },
      }));
      t.after(() => release.resolve());
      await f.sync.synchronize(f.orders[0].id, new AbortController().signal);
      const invoice = (
        await f.repo.list(f.orders[0].companyId, { offset: 0, limit: 20 })
      ).items[0];
      const buyer = f.data.users.findIndex(
        (u) => u.role === "CUSTOMER_ADMIN" && u.companyId === invoice.companyId,
      );
      const token = (await f.login(buyer)).accessToken;
      const pending = fetch(f.url + `/api/v1/invoices/${invoice.id}/document`, {
        headers: { Authorization: "Bearer " + token },
      });
      await entered.promise;
      await f.setUser({ status: "SUSPENDED" }, buyer);
      release.resolve();
      const result = await pending;
      assert.notEqual(result.status, 200);
      assert.doesNotMatch(
        await result.text(),
        /SYNTHETIC DEMO|erpInvoiceReference/,
      );
    },
  );
  test(
    `${provider}: changed invoice/order link during retrieval fails closed without mutation`,
    options,
    async (t) => {
      const entered = barrier(),
        release = barrier();
      const f = await fixture(t, provider, (source) => ({
        async read(...args) {
          const bytes = await source.read(...args);
          entered.resolve();
          await release.promise;
          return bytes;
        },
      }));
      t.after(() => release.resolve());
      await f.sync.synchronize(f.orders[0].id, new AbortController().signal);
      const invoice = (
        await f.repo.list(f.orders[0].companyId, { offset: 0, limit: 20 })
      ).items[0];
      const buyer = f.data.users.findIndex(
        (u) => u.role === "CUSTOMER_ADMIN" && u.companyId === invoice.companyId,
      );
      const pending = f.get(`/api/v1/invoices/${invoice.id}/document`, buyer);
      await entered.promise;
      if (provider === "json") {
        const rows = await f.security.store.read("orders");
        await f.security.store.replace(
          "orders",
          rows.map((r) =>
            r.id === invoice.orderId
              ? { ...r, erpOrderReference: randomUUID() }
              : r,
          ),
        );
      } else
        await f.pool.query(
          "UPDATE orders SET erp_order_reference=$1 WHERE id=$2",
          [randomUUID(), invoice.orderId],
        );
      release.resolve();
      const result = await pending;
      assert.equal(result.status, 503);
      assert.doesNotMatch(
        await result.text(),
        /SYNTHETIC DEMO|erpInvoiceReference/,
      );
    },
  );
}
test("Mock document adapter rejects redirects, oversized, corrupt UTF-8, mismatched metadata and uncertain sources", async (t) => {
  const f = await fixture(t, "json");
  await f.sync.synchronize(f.orders[0].id, new AbortController().signal);
  const invoice = (
      await f.repo.list(f.orders[0].companyId, { offset: 0, limit: 20 })
    ).items[0],
    link = await f.repo.link(invoice.orderId);
  const headers = {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="mock-invoice-${link.erpOrderReference}.txt"`,
  };
  for (const scenario of [
    "redirect",
    "oversize",
    "utf8",
    "mismatch",
    "missing",
    "timeout",
  ]) {
    const url = await serve(t, (req, res) => {
      if (scenario === "timeout") return;
      if (scenario === "redirect") {
        res.writeHead(302, { location: f.erpBaseUrl });
        return res.end();
      }
      if (scenario === "missing") {
        res.writeHead(404);
        return res.end();
      }
      const bytes =
        scenario === "oversize"
          ? Buffer.alloc(4097, 65)
          : scenario === "utf8"
            ? Buffer.from([255])
            : Buffer.from(
                "SYNTHETIC DEMO INVOICE REFERENCE\nNOT A TAX INVOICE - NO FINANCIAL AUTHORITY\n\n{}",
              );
      res.writeHead(200, {
        ...headers,
        "content-length": String(bytes.length),
      });
      res.end(bytes);
    });
    const source = createMockInvoiceDocuments({
      baseUrl: url + "/mock-erp/v1/",
      timeoutMs: 100,
    });
    await assert.rejects(
      source.read(invoice, link, new AbortController().signal),
      /Invoice operation/,
    );
  }
});
