import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import express from "express";
import { Client, Pool } from "pg";
import { createApp as mockApp } from "../../mock-erp/dist/app.js";
import { createMockCatalogSource } from "../dist/infrastructure/mock-catalog-adapter.js";
import { createJsonCatalogCache } from "../dist/infrastructure/json/catalog-cache.js";
import { createPostgresCatalogCache } from "../dist/infrastructure/postgres-catalog-cache.js";
import {
  createCatalogSync,
  checkedCatalog,
  CatalogSyncError,
} from "../dist/services/catalog-sync.js";
import { seedJson, seedPostgres } from "../dist/demo/seed.js";
import { demoId } from "../dist/demo/dataset.js";
import { JsonFileStore } from "../dist/infrastructure/json/store.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import {
  loadMigrations,
  runMigrations,
} from "../dist/infrastructure/migrations.js";
async function serve(t, app = mockApp()) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  return `http://127.0.0.1:${server.address().port}/mock-erp/v1/`;
}
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "b2b-catalog-")),
    directory = join(parent, "b2b_demo_catalog");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await seedJson(directory, {
    mode: "seed",
    confirmTarget: "b2b_demo_catalog",
  });
  return {
    parent,
    directory,
    cache: createJsonCatalogCache(directory, "b2b_demo_catalog", true),
    store: new JsonFileStore(directory),
  };
}
async function contents(directory) {
  return Promise.all(
    [
      "products.json",
      "customer_product_access.json",
      "customer_product_prices.json",
    ].map((file) => readFile(join(directory, file), "utf8")),
  );
}
const signal = () => new AbortController().signal;
test("real Mock snapshot populates JSON catalog with tenant pricing, stable IDs and unchanged portal/private data", async (t) => {
  const source = createMockCatalogSource({
      baseUrl: await serve(t),
      timeoutMs: 1000,
    }),
    f = await fixture(t);
  await writeFile(join(f.directory, "order_internal_notes.json"), "[]\n");
  await writeFile(join(f.directory, "audit_logs.json"), "[]\n");
  const preserved = [
      "companies.json",
      "users.json",
      "orders.json",
      "order_internal_notes.json",
      "audit_logs.json",
    ],
    before = await Promise.all(
      preserved.map((file) => readFile(join(f.directory, file), "utf8")),
    );
  let generated = 0;
  const sync = createCatalogSync(source, f.cache, () => {
    generated++;
    return randomUUID();
  });
  assert.deepEqual(await sync.synchronize(signal()), {
    products: 5,
    access: 10,
    prices: 1,
  });
  assert.equal(generated, 2);
  const original = await f.store.read("products");
  await sync.synchronize(signal());
  assert.equal(generated, 2);
  assert.deepEqual(await f.store.read("products"), original);
  assert.equal(
    original.find((p) => p.erpProductReference === "DEMO-P001").id,
    demoId(101),
  );
  const ports = createJsonRepositories(f.store),
    page = { offset: 0, limit: 100 };
  const a = await ports.catalog.listEligible({ companyId: demoId(1) }, page),
    b = await ports.catalog.listEligible({ companyId: demoId(2) }, page);
  assert.equal(a.total, 4);
  assert.equal(b.total, 3);
  assert.equal(
    a.items.find((p) => p.sku === "DEMO-RICE-BAG").price.amount,
    "27.50",
  );
  assert.equal(
    b.items.find((p) => p.sku === "DEMO-RICE-BAG").price.amount,
    "30.00",
  );
  assert.equal(a.items.find((p) => p.sku === "DEMO-UNPRICED-PACK").price, null);
  assert.equal(
    a.items.find((p) => p.sku === "DEMO-APPLE-KG").minimumOrderQuantity,
    "0.5",
  );
  assert.ok(a.items.every((p) => !Object.hasOwn(p, "erpProductReference")));
  assert.deepEqual(
    await Promise.all(
      preserved.map((file) => readFile(join(f.directory, file), "utf8")),
    ),
    before,
  );
  assert.deepEqual(await readdir(f.parent), ["b2b_demo_catalog"]);
});
test("removed products become inactive, unlinked customers are not created and inactive ERP customers lose eligibility", async (t) => {
  const source = createMockCatalogSource({
      baseUrl: await serve(t),
      timeoutMs: 1000,
    }),
    f = await fixture(t);
  await createCatalogSync(source, f.cache, randomUUID).synchronize(signal());
  const data = await source.readSnapshot(signal());
  data.products = data.products.filter((p) => p.reference !== "DEMO-P005");
  data.access = data.access.filter((a) => a.productReference !== "DEMO-P005");
  data.customers[0].active = false;
  data.customers.push({ reference: "UNLINKED", active: true });
  data.access.push({
    customerReference: "UNLINKED",
    productReference: "DEMO-P001",
    eligible: true,
  });
  await createCatalogSync(
    {
      async readSnapshot() {
        return data;
      },
    },
    f.cache,
    randomUUID,
  ).synchronize(signal());
  const products = await f.store.read("products");
  assert.equal(
    products.find((p) => p.erpProductReference === "DEMO-P005").active,
    false,
  );
  assert.equal((await f.store.read("companies")).length, 2);
  assert.equal(
    (
      await createJsonRepositories(f.store).catalog.listEligible(
        { companyId: demoId(1) },
        { offset: 0, limit: 100 },
      )
    ).total,
    0,
  );
});

test("invalid snapshots and cancellation do not enter a repository mutation", async (t) => {
  const source = createMockCatalogSource({
      baseUrl: await serve(t),
      timeoutMs: 1000,
    }),
    valid = await source.readSnapshot(signal());
  let calls = 0;
  for (const change of [
    (s) => s.products.push(s.products[0]),
    (s) => (s.prices[0].price.amount = "NaN"),
    (s) => (s.access[0].customerReference = "DO_NOT_LEAK"),
    (s) => s.products.splice(0),
    (s) => (s.products[0].minimumOrderQuantity = "0"),
    (s) => (s.prices[0].price.validTo = "2020-01-01T00:00:00.000Z"),
  ]) {
    const value = structuredClone(valid);
    change(value);
    const sync = createCatalogSync(
      {
        async readSnapshot() {
          return value;
        },
      },
      {
        async refresh() {
          calls++;
        },
      },
      randomUUID,
    );
    await assert.rejects(sync.synchronize(signal()), CatalogSyncError);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createCatalogSync(
      source,
      {
        async refresh() {
          calls++;
        },
      },
      randomUUID,
    ).synchronize(controller.signal),
    CatalogSyncError,
  );
  assert.equal(calls, 0);
  assert.throws(() => checkedCatalog({}), CatalogSyncError);
});
test("JSON requires offline ownership and unknown-data refusal; staged validation failure preserves the entire old cache", async (t) => {
  const f = await fixture(t),
    source = createMockCatalogSource({
      baseUrl: await serve(t),
      timeoutMs: 1000,
    }),
    before = await contents(f.directory);
  await assert.rejects(
    createCatalogSync(
      source,
      createJsonCatalogCache(f.directory, "b2b_demo_catalog", false),
      randomUUID,
    ).synchronize(signal()),
    CatalogSyncError,
  );
  let n = 0;
  await assert.rejects(
    createCatalogSync(source, f.cache, () =>
      ++n === 1 ? randomUUID() : "DO_NOT_LEAK",
    ).synchronize(signal()),
    CatalogSyncError,
  );
  assert.deepEqual(await contents(f.directory), before);
  assert.deepEqual(await readdir(f.parent), ["b2b_demo_catalog"]);
  await writeFile(join(f.directory, "unknown.txt"), "keep");
  await assert.rejects(
    createCatalogSync(source, f.cache, randomUUID).synchronize(signal()),
    CatalogSyncError,
  );
  assert.equal(
    await readFile(join(f.directory, "unknown.txt"), "utf8"),
    "keep",
  );
});
test("Mock catalog adapter bounds bad status/type/UTF-8/size, redirects and stalled response bodies", async (t) => {
  for (const scenario of [
    "status",
    "type",
    "utf8",
    "size",
    "redirect",
    "stall",
  ]) {
    const app = express();
    app.get("/mock-erp/v1/master-data", (_req, res) => {
      if (scenario === "status") return res.status(503).send("DO_NOT_LEAK");
      if (scenario === "type") return res.type("text/plain").send("{}");
      if (scenario === "utf8")
        return res.type("application/json").send(Buffer.from([255]));
      if (scenario === "size")
        return res.type("application/json").send("x".repeat(1048577));
      if (scenario === "redirect") return res.redirect("/DO_NOT_LEAK");
      res.type("application/json").write("{");
    });
    const source = createMockCatalogSource({
      baseUrl: await serve(t, app),
      timeoutMs: 75,
    });
    await assert.rejects(
      source.readSnapshot(signal()),
      (error) =>
        error instanceof CatalogSyncError &&
        !error.message.includes("DO_NOT_LEAK"),
    );
  }
});
test("actual catalog CLI refreshes a confirmed JSON demo from real Mock HTTP and redacts unsafe arguments", async (t) => {
  const f = await fixture(t),
    base = await serve(t),
    entry = fileURLToPath(new URL("../dist/sync-catalog.js", import.meta.url));
  async function run(args) {
    const child = spawn(process.execPath, [entry, ...args], {
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        ERP_BASE_URL: base,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: AbortSignal.timeout(10000),
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    const [code] = await once(child, "close");
    return { code, out, err };
  }
  const args = [
      "--provider",
      "json",
      "--directory",
      f.directory,
      "--confirm-target",
      "b2b_demo_catalog",
      "--offline",
    ],
    good = await run(args);
  assert.equal(good.code, 0, good.err);
  assert.equal(JSON.parse(good.out).event, "catalog.synced");
  const bad = await run(["--provider", "DO_NOT_LEAK"]);
  assert.equal(bad.code, 1);
  assert.ok(!bad.err.includes("DO_NOT_LEAK"));
});
test(
  "real PostgreSQL sync is transactional, stable, scoped and equivalent to JSON with rollback on SQL failure",
  {
    skip: process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL
      ? false
      : "Set B2B_TEST_MIGRATIONS_CLI_DATABASE_URL",
    timeout: 30000,
  },
  async (t) => {
    const url = new URL(process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL),
      admin = new Client({ connectionString: url.href });
    await admin.connect();
    const name = `b2b_demo_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    const client = new Client({ connectionString: url.href });
    await client.connect();
    const pool = new Pool({ connectionString: url.href });
    t.after(async () => {
      try {
        await pool.end();
        await client.end();
        await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
    });
    await runMigrations(
      client,
      await loadMigrations(new URL("../migrations/", import.meta.url)),
    );
    await seedPostgres(client, { mode: "seed", confirmTarget: name });
    const f = await fixture(t),
      source = createMockCatalogSource({
        baseUrl: await serve(t),
        timeoutMs: 1000,
      });
    const extraIds = [randomUUID(), randomUUID()];
    let a = 0,
      b = 0;
    const sql = createCatalogSync(
        source,
        createPostgresCatalogCache(pool),
        () => extraIds[a++],
      ),
      json = createCatalogSync(source, f.cache, () => extraIds[b++]);
    await sql.synchronize(signal());
    await json.synchronize(signal());
    await sql.synchronize(signal());
    assert.equal(a, 2);
    const sqlPorts = createPostgresRepositories(pool),
      jsonPorts = createJsonRepositories(f.store),
      page = { offset: 0, limit: 100 };
    for (const n of [1, 2])
      assert.deepEqual(
        await sqlPorts.catalog.listEligible({ companyId: demoId(n) }, page),
        await jsonPorts.catalog.listEligible({ companyId: demoId(n) }, page),
      );
    const before = (
      await client.query("SELECT id,sku,name FROM products ORDER BY id")
    ).rows;
    await client.query(
      "ALTER TABLE products ADD CONSTRAINT test_sync_failure CHECK(sku<>'DEMO-APPLE-KG') NOT VALID",
    );
    const changed = await source.readSnapshot(signal());
    changed.products[0].name = "Updated synthetic rice";
    await assert.rejects(
      createCatalogSync(
        {
          async readSnapshot() {
            return changed;
          },
        },
        createPostgresCatalogCache(pool),
        randomUUID,
      ).synchronize(signal()),
      CatalogSyncError,
    );
    assert.deepEqual(
      (await client.query("SELECT id,sku,name FROM products ORDER BY id")).rows,
      before,
    );
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM users")).rows[0].n,
      6,
    );
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM orders")).rows[0].n,
      3,
    );
  },
);
