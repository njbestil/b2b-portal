import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createApp } from "../dist/app.js";
import { createApp as createMock } from "../../mock-erp/dist/app.js";
import { createJsonInvoices } from "../dist/infrastructure/json/invoices.js";
import { createPostgresInvoices } from "../dist/infrastructure/postgres-invoices.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import {
  createInvoiceSync,
  createInvoiceQueries,
  checkedInvoiceMetadata,
  invoiceId,
} from "../dist/services/invoices.js";
import { createMockInvoiceSource } from "../dist/infrastructure/mock-invoice-adapter.js";
import { createJsonCatalogCache } from "../dist/infrastructure/json/catalog-cache.js";
import { seedJson } from "../dist/demo/seed.js";
async function serve(t, app) {
  const server = app.listen(0, "127.0.0.1");
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
async function fixture(t, provider) {
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
  f.url = await serve(
    t,
    createApp({
      sessions: f.auth,
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
    `${provider}: real Mock invoices sync idempotently with exact metadata and customer-only tenant API`,
    options,
    async (t) => {
      const f = await fixture(t, provider);
      const initialCustomer = f.data.users.findIndex(
        (u) =>
          u.companyId === f.orders[0].companyId && u.role === "CUSTOMER_ADMIN",
      );
      assert.equal(
        (await (await f.get("/api/v1/invoices", initialCustomer)).json()).data
          .total,
        0,
      );
      for (const order of f.orders)
        assert.deepEqual(
          await f.sync.synchronize(order.id, new AbortController().signal),
          { available: true },
        );
      const company = f.data.companies[0].id,
        page = await f.repo.list(company, { offset: 0, limit: 20 }),
        invoice = page.items[0];
      assert.equal(page.total, 1);
      assert.equal(invoice.amount, "100.00");
      assert.equal(invoice.currency, "AED");
      await Promise.all(
        Array.from({ length: 4 }, () =>
          f.sync.synchronize(f.orders[0].id, new AbortController().signal),
        ),
      );
      assert.equal(
        (await f.repo.list(company, { offset: 0, limit: 20 })).items[0].id,
        invoice.id,
      );
      for (const role of ["CUSTOMER_ADMIN", "CUSTOMER_USER"]) {
        const own = f.data.users.findIndex(
            (u) => u.companyId === company && u.role === role,
          ),
          foreign = f.data.users.findIndex(
            (u) => u.companyId !== company && u.companyId && u.role === role,
          );
        const response = await f.get("/api/v1/invoices?offset=0&limit=1", own);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const body = await response.json();
        assert.equal(body.data.total, 1);
        assert.equal(body.data.items[0].id, invoice.id);
        assert.equal(body.data.items[0].documentAvailable, true);
        assert.equal(JSON.stringify(body).includes("MOCK-INV"), false);
        assert.equal(JSON.stringify(body).includes("mock-invoice:"), false);
        assert.equal(JSON.stringify(body).includes("DEMO-C001"), false);
        assert.equal(
          (await f.get("/api/v1/invoices/" + invoice.id, own)).status,
          200,
        );
        assert.equal(
          (await f.get("/api/v1/invoices/" + invoice.id, foreign)).status,
          404,
        );
        assert.equal(
          (await f.get("/api/v1/invoices/" + randomUUID(), foreign)).status,
          404,
        );
        for (const query of [
          "companyId=" + company,
          "limit=101",
          "offset=-1",
          "limit=1&limit=2",
          "limit=1%0A",
        ]) {
          assert.equal(
            (await f.get("/api/v1/invoices?" + query, own)).status,
            400,
          );
        }
      }
      assert.equal((await f.get("/api/v1/invoices")).status, 401);
      for (const role of ["INTERNAL_ADMIN", "SALES_STAFF"]) {
        assert.equal(
          (
            await f.get(
              "/api/v1/invoices",
              f.data.users.findIndex((u) => u.role === role),
            )
          ).status,
          403,
        );
      }
      const customer = f.data.users.findIndex(
        (u) => u.companyId === company && u.role === "CUSTOMER_ADMIN",
      );
      await f.setUser({ mustChangePassword: true }, customer);
      assert.equal((await f.get("/api/v1/invoices", customer)).status, 403);
      await f.setUser(
        { mustChangePassword: false, status: "SUSPENDED" },
        customer,
      );
      await assert.rejects(f.login(customer));
    },
  );
  test(
    `${provider}: correlation changes, null/error sources and reference collisions preserve existing invoices`,
    options,
    async (t) => {
      const f = await fixture(t, provider),
        order = f.orders[0],
        signal = new AbortController().signal;
      await f.sync.synchronize(order.id, signal);
      const original = (
        await f.repo.list(order.companyId, { offset: 0, limit: 20 })
      ).items[0];
      const nullSync = createInvoiceSync(
        { read: async () => null },
        f.repo,
        randomUUID,
      );
      assert.deepEqual(await nullSync.synchronize(order.id, signal), {
        available: false,
      });
      await assert.rejects(
        createInvoiceSync(
          {
            read: async () => {
              throw Error("PRIVATE_ERP");
            },
          },
          f.repo,
          randomUUID,
        ).synchronize(order.id, signal),
      );
      const wrongLink = await f.repo.link(f.orders[1].id);
      await assert.rejects(
        f.repo.save(wrongLink, {
          ...original,
          orderId: wrongLink.orderId,
          companyId: wrongLink.companyId,
          documentReference: `mock-invoice:${wrongLink.erpOrderReference}`,
        }),
      );
      const current = await f.repo.link(order.id),
        changed = { ...current, customerReference: "OTHER_CUSTOMER" };
      await assert.rejects(f.repo.save(changed, original));
      assert.deepEqual(
        (await f.repo.list(order.companyId, { offset: 0, limit: 20 })).items[0],
        original,
      );
      await assert.rejects(f.sync.synchronize(randomUUID(), signal), {
        code: "not_found",
      });
      const aborted = new AbortController();
      aborted.abort();
      await assert.rejects(f.sync.synchronize(order.id, aborted.signal));
      if (provider === "json") {
        const broken = createJsonInvoices(f.security, {
          open: fs.open,
          unlink: fs.unlink,
          rename: async () => {
            throw Error("PRIVATE_RENAME_FAILURE");
          },
        });
        await assert.rejects(
          createInvoiceSync(f.source, broken, randomUUID).synchronize(
            order.id,
            signal,
          ),
        );
        assert.deepEqual(
          (await f.repo.list(order.companyId, { offset: 0, limit: 20 }))
            .items[0],
          original,
        );
        const reopened = createJsonInvoices(f.security);
        assert.deepEqual(
          await reopened.find(order.companyId, original.id),
          original,
        );
      } else {
        await f.pool.query(
          "CREATE FUNCTION invoice80_refuse_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_WRITE_FAILURE'; END $$",
        );
        await f.pool.query(
          "CREATE TRIGGER invoice80_refuse BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoice80_refuse_update()",
        );
        await assert.rejects(f.sync.synchronize(order.id, signal));
        assert.deepEqual(
          (await f.repo.list(order.companyId, { offset: 0, limit: 20 }))
            .items[0],
          original,
        );
      }
    },
  );
}
test("bounded invoice adapter rejects malformed/cross-linked/unsafe payloads, redirects, size, UTF-8 and timeout", async (t) => {
  const link = {
    orderId: randomUUID(),
    companyId: randomUUID(),
    erpOrderReference: randomUUID(),
    customerReference: "DEMO-C001",
  };
  const valid = {
    erpInvoiceReference: "REF",
    portalOrderId: link.orderId,
    erpOrderId: link.erpOrderReference,
    customerId: link.customerReference,
    invoiceNumber: "N",
    amount: "100.00",
    currency: "AED",
    status: "available",
    documentReference: `mock-invoice:${link.erpOrderReference}`,
    issuedAt: new Date().toISOString(),
  };
  let mode = "valid";
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (mode === "timeout") return;
    if (mode === "redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:1/" });
      return res.end();
    }
    if (mode === "error") {
      res.statusCode = 503;
      return res.end('{"private":"PRIVATE"}');
    }
    if (mode === "size") return res.end(" ".repeat(16385));
    if (mode === "utf8") return res.end(Buffer.from([255]));
    const row = { ...valid };
    if (mode === "customer") row.customerId = "DEMO-C002";
    if (mode === "order") row.portalOrderId = randomUUID();
    if (mode === "erp") row.erpOrderId = randomUUID();
    if (mode === "document")
      row.documentReference = "https://example.test/private";
    if (mode === "amount") row.amount = 100;
    if (mode === "date") row.issuedAt = "yesterday";
    if (mode === "extra") row.extra = "private";
    res.end(JSON.stringify({ invoice: mode === "null" ? null : row }));
  });
  const base = await serve(t, server),
    source = createMockInvoiceSource({
      baseUrl: base + "/mock-erp/v1/",
      timeoutMs: 500,
    });
  assert.equal(
    (await source.read(link, new AbortController().signal)).amount,
    "100.00",
  );
  mode = "null";
  assert.equal(await source.read(link, new AbortController().signal), null);
  for (mode of [
    "customer",
    "order",
    "erp",
    "document",
    "amount",
    "date",
    "extra",
    "redirect",
    "error",
    "size",
    "utf8",
    "timeout",
  ]) {
    await assert.rejects(
      source.read(link, new AbortController().signal),
      (e) => !e.message.includes("PRIVATE"),
    );
  }
  for (const amount of [100, "-1", "1e2", "NaN", "100\n"]) {
    assert.throws(() => checkedInvoiceMetadata({ ...valid, amount }));
  }
  assert.throws(() => checkedInvoiceMetadata({ ...valid, currency: "AED\n" }));
  assert.throws(() =>
    checkedInvoiceMetadata({
      ...valid,
      documentReference: "mock-invoice:" + "-".repeat(36),
    }),
  );
  assert.throws(() => invoiceId(link.orderId + "\n"));
});
test("JSON cache survives reopen/catalog refresh, refuses corruption, and explicit owned reset clears it", async (t) => {
  const root = await fs.mkdtemp(
    join((await import("node:os")).tmpdir(), "invoice80-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = join(root, "b2b_demo_invoice80");
  await seedJson(directory, {
    mode: "seed",
    confirmTarget: "b2b_demo_invoice80",
  });
  const bytes = "[]\n";
  await fs.writeFile(join(directory, "invoices.json"), bytes);
  await createJsonCatalogCache(directory, "b2b_demo_invoice80", true).refresh(
    () => ({
      products: [],
      customer_product_access: [],
      customer_product_prices: [],
    }),
  );
  assert.equal(
    await fs.readFile(join(directory, "invoices.json"), "utf8"),
    bytes,
  );
  await seedJson(directory, {
    mode: "reset",
    confirmTarget: "b2b_demo_invoice80",
  });
  await assert.rejects(fs.stat(join(directory, "invoices.json")), {
    code: "ENOENT",
  });
  const { JsonSecurityCoordinator } =
    await import("../dist/infrastructure/json/security.js");
  const repo = createJsonInvoices(new JsonSecurityCoordinator(directory));
  assert.equal(
    (await repo.list(randomUUID(), { offset: 0, limit: 20 })).total,
    0,
  );
  await fs.writeFile(
    join(directory, "invoices.json"),
    '[{"private":"unknown"}]',
  );
  await assert.rejects(repo.list(randomUUID(), { offset: 0, limit: 20 }));
});
test("operator CLI refuses missing offline/unsafe target/configuration with fixed diagnostics", async () => {
  for (const args of [
    [],
    [
      "--provider",
      "json",
      "--directory",
      "C:/not-owned",
      "--confirm-target",
      "b2b_demo_x",
      "--order",
      randomUUID(),
    ],
    [
      "--provider",
      "json",
      "--directory",
      "C:/not-owned",
      "--confirm-target",
      "b2b_demo_x",
      "--offline",
      "--order",
      randomUUID(),
    ],
  ]) {
    const result = await new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../dist/sync-invoice.js", import.meta.url)),
          ...args,
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: "development",
            DATABASE_URL: "",
            ERP_BASE_URL: "http://127.0.0.1:1/mock-erp/v1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      p.stdout.on("data", (c) => (output += c));
      p.stderr.on("data", (c) => (output += c));
      p.on("error", reject);
      p.on("close", (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 1);
    assert.equal(result.output.trim(), '{"event":"invoice.sync_failed"}');
  }
});

test("actual JSON operator CLI syncs a linked Mock invoice, retains identity, honors writer lock and exposes only fixed events", async (t) => {
  const f = await fixture(t, "json"),
    order = f.orders[0];
  const root = await fs.mkdtemp(
    join((await import("node:os")).tmpdir(), "invoice80-cli-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = join(root, "b2b_demo_invoice80_cli");
  await seedJson(directory, {
    mode: "seed",
    confirmTarget: "b2b_demo_invoice80_cli",
  });
  const rows = await f.security.store.read("orders");
  await fs.writeFile(join(directory, "orders.json"), JSON.stringify(rows));
  async function run() {
    return new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../dist/sync-invoice.js", import.meta.url)),
          "--provider",
          "json",
          "--directory",
          directory,
          "--confirm-target",
          "b2b_demo_invoice80_cli",
          "--offline",
          "--order",
          order.id,
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: "development",
            DATABASE_URL: "",
            ERP_BASE_URL: f.erpBaseUrl,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      p.stdout.on("data", (b) => (output += b));
      p.stderr.on("data", (b) => (output += b));
      p.on("error", reject);
      p.on("close", (code) => resolve({ code, output }));
    });
  }
  for (let i = 0; i < 2; i++) {
    const result = await run();
    assert.equal(result.code, 0);
    assert.equal(
      result.output.trim(),
      '{"event":"invoice.synced","available":true}',
    );
  }
  const saved = JSON.parse(
    await fs.readFile(join(directory, "invoices.json"), "utf8"),
  );
  assert.equal(saved.length, 1);
  assert.equal(saved[0].amount, "100.00");
  const lock = join(root, ".b2b_demo_invoice80_cli.lock");
  await fs.writeFile(lock, "");
  const refused = await run();
  assert.equal(refused.code, 1);
  assert.equal(refused.output.trim(), '{"event":"invoice.sync_failed"}');
  assert.equal(
    await fs.readFile(join(directory, "invoices.json"), "utf8"),
    JSON.stringify(saved, null, 2) + "\n",
  );
});

test(
  "actual PostgreSQL operator CLI requires a marked local target and synchronizes without duplicate identity",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL &&
      "Set disposable B2B_TEST_MIGRATIONS_CLI_DATABASE_URL",
  },
  async (t) => {
    const { Client } = await import("pg"),
      admin = new Client({
        connectionString: process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL,
      });
    await admin.connect();
    const target =
      "b2b_demo_invoice80_" + randomUUID().replaceAll("-", "").slice(0, 12);
    await admin.query(`CREATE DATABASE "${target}"`);
    const url = new URL(process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL);
    url.pathname = "/" + target;
    const client = new Client({ connectionString: url.href });
    await client.connect();
    t.after(async () => {
      await client.end();
      await admin.query(`DROP DATABASE "${target}"`);
      await admin.end();
    });
    const { loadMigrations, runMigrations } =
      await import("../dist/infrastructure/migrations.js");
    await runMigrations(
      client,
      await loadMigrations(new URL("../migrations/", import.meta.url)),
    );
    const { createDemoData } = await import("../dist/demo/dataset.js"),
      data = createDemoData(),
      order = data.orders.find((r) => r.status === "CONFIRMED"),
      company = data.companies.find((c) => c.id === order.companyId);
    const base = await serve(t, createMock()),
      response = await fetch(base + "/mock-erp/v1/orders", {
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
    assert.equal(response.status, 201);
    const erpOrder = (await response.json()).erpOrderId;
    async function run() {
      return new Promise((resolve, reject) => {
        const p = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("../dist/sync-invoice.js", import.meta.url)),
            "--provider",
            "postgresql",
            "--confirm-target",
            target,
            "--offline",
            "--order",
            order.id,
          ],
          {
            env: {
              ...process.env,
              NODE_ENV: "development",
              DATABASE_URL: url.href,
              ERP_BASE_URL: base + "/mock-erp/v1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        p.stdout.on("data", (b) => (output += b));
        p.stderr.on("data", (b) => (output += b));
        p.on("error", reject);
        p.on("close", (code) => resolve({ code, output }));
      });
    }
    assert.equal((await run()).code, 1);
    const { seedPostgres } = await import("../dist/demo/seed.js");
    await seedPostgres(client, { mode: "seed", confirmTarget: target });
    await client.query("UPDATE orders SET erp_order_reference=$1 WHERE id=$2", [
      erpOrder,
      order.id,
    ]);
    let id;
    for (let i = 0; i < 2; i++) {
      const result = await run();
      assert.equal(result.code, 0);
      assert.equal(
        result.output.trim(),
        '{"event":"invoice.synced","available":true}',
      );
      const rows = (
        await client.query("SELECT id,amount::text AS amount FROM invoices")
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].amount, "100.00");
      if (id) assert.equal(rows[0].id, id);
      id = rows[0].id;
    }
  },
);
