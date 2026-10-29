import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client, Pool } from "pg";
import {
  EnvironmentConfigurationError,
  parseStorageEnvironment,
  parsePostgresEnvironment,
} from "@b2b-portal/config/server";
import { selectStorage } from "../dist/infrastructure/storage.js";
import {
  createPostgresRepositories,
  PostgresStorageError,
} from "../dist/infrastructure/postgres-repositories.js";
import { JsonFileStore } from "../dist/infrastructure/json/store.js";
import { JsonStorageError } from "../dist/infrastructure/json/models.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createCompanyQueries } from "../dist/services/company-queries.js";
import { createCatalogQueries } from "../dist/services/catalog-queries.js";
import { createOrderQueries } from "../dist/services/order-queries.js";
import {
  loadMigrations,
  runMigrations,
} from "../dist/infrastructure/migrations.js";
import { createApp } from "../dist/app.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const a = { companyId: id(1) },
  b = { companyId: id(2) };
const at = "2026-10-29T12:00:00.000Z";
const price = (amount, validFrom = null, validTo = null) => ({
  amount,
  currency: "AED",
  validFrom,
  validTo,
});
function dataset() {
  return {
    companies: [1, 2].map((n) => ({
      id: id(n),
      legalName: `Company ${n}`,
      tradeName: `Trade ${n}`,
      status: "ACTIVE",
      erpCustomerReference: null,
    })),
    users: [
      {
        id: id(11),
        companyId: id(1),
        displayName: "Buyer A",
        role: "CUSTOMER_USER",
        status: "ACTIVE",
      },
      {
        id: id(12),
        companyId: id(1),
        displayName: "Admin A",
        role: "CUSTOMER_ADMIN",
        status: "SUSPENDED",
      },
      {
        id: id(21),
        companyId: id(2),
        displayName: "Buyer B",
        role: "CUSTOMER_USER",
        status: "ACTIVE",
      },
      {
        id: id(31),
        companyId: null,
        displayName: "Internal",
        role: "INTERNAL_ADMIN",
        status: "ACTIVE",
      },
    ],
    products: [101, 102, 103, 104].map((n) => ({
      id: id(n),
      sku: `SKU-${n}`,
      name: `Product ${n}`,
      sellingUom: "KG",
      minimumOrderQuantity: "0.125",
      active: n !== 103,
      defaultPrice: n === 104 ? null : price("10.000000000000000001"),
    })),
    customer_product_access: [
      ...[101, 102, 103, 104].map((n) => ({
        companyId: id(1),
        productId: id(n),
        eligible: true,
      })),
      { companyId: id(2), productId: id(101), eligible: true },
      { companyId: id(2), productId: id(102), eligible: false },
    ],
    customer_product_prices: [
      {
        companyId: id(1),
        productId: id(101),
        price: price("7.30", at, "2026-10-30T00:00:00.000Z"),
      },
      { companyId: id(2), productId: id(101), price: price("99.99") },
      { companyId: id(1), productId: id(102), price: price("1.00", null, at) },
    ],
    orders: [201, 202, 203].map((n) => ({
      id: id(n),
      companyId: n === 203 ? id(2) : id(1),
      orderNumber: null,
      createdByUserId: n === 203 ? id(21) : id(11),
      createdAt: at,
      status: "SUBMITTED",
      integrationStatus: "FAILED",
    })),
  };
}
async function jsonFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "b2b-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonFileStore(directory);
  for (const [name, rows] of Object.entries(dataset()))
    await store.replace(name, rows);
  return { directory, store };
}
function settings(directory, overrides = {}) {
  return {
    jsonDirectory: directory,
    startupTimeoutMs: 50,
    logger: () => {},
    ...overrides,
  };
}
function fakePostgres(up = true) {
  const state = { probes: 0, closes: 0, queries: [], up };
  const resource = {
    pool: {
      async query(sql, values) {
        state.queries.push({ sql, values });
        throw new Error("DO_NOT_LEAK_DATABASE");
      },
    },
    async health() {
      state.probes++;
      return state.up;
    },
    async probe() {
      return state.up;
    },
    async close() {
      state.closes++;
    },
  };
  return { state, resource, make: () => resource };
}
const pgConfig = parsePostgresEnvironment({
  DATABASE_URL: "postgresql://demo:DO_NOT_LEAK@127.0.0.1:1/demo",
});

test("storage configuration defaults, bounds and diagnostics never reveal setting values", () => {
  assert.deepEqual(parseStorageEnvironment({}), {
    jsonDataDir: undefined,
    startupTimeoutMs: 1000,
  });
  assert.equal(
    parseStorageEnvironment({
      JSON_DATA_DIR: "data/custom",
      STORAGE_STARTUP_TIMEOUT_MS: "1",
    }).jsonDataDir,
    "data/custom",
  );
  for (const value of ["0", "60001", "1.5", "DO_NOT_LEAK", ""])
    assert.throws(
      () => parseStorageEnvironment({ STORAGE_STARTUP_TIMEOUT_MS: value }),
      (error) =>
        error instanceof EnvironmentConfigurationError &&
        !error.message.includes("DO_NOT_LEAK"),
    );
  assert.throws(
    () => parseStorageEnvironment({ JSON_DATA_DIR: " DO_NOT_LEAK " }),
    (error) => !error.message.includes("DO_NOT_LEAK"),
  );
});

test("unconfigured PostgreSQL selects usable JSON read ports once; missing/corrupt files are unhealthy", async (t) => {
  const { directory, store } = await jsonFixture(t);
  const runtime = await selectStorage(settings(directory), () =>
    assert.fail("must not construct a pool"),
  );
  assert.equal(runtime.provider, "json");
  assert.ok(Object.isFrozen(runtime));
  assert.equal(await runtime.health(new AbortController().signal), true);
  assert.equal(
    (
      await createCompanyQueries(
        runtime.repositories.companies,
        runtime.repositories.users,
      ).getProfile(a)
    ).legalName,
    "Company 1",
  );
  await writeFile(join(directory, "companies.json"), "invalid DO_NOT_LEAK");
  assert.equal(await runtime.health(new AbortController().signal), false);
  await assert.rejects(
    runtime.repositories.companies.findById(a),
    JsonStorageError,
  );
  assert.equal(runtime.provider, "json");
  await store.replace("companies", dataset().companies);
  assert.equal(await runtime.health(new AbortController().signal), true);
  await runtime.close();
  const missing = await selectStorage(settings(join(directory, "missing")));
  assert.equal(missing.provider, "json");
  assert.equal(await missing.health(new AbortController().signal), false);
  await missing.close();
});

test("unavailable/throwing PostgreSQL selects JSON, retires pool once and never promotes on recovery", async (t) => {
  const { directory } = await jsonFixture(t);
  for (const throws of [false, true]) {
    const f = fakePostgres(false);
    if (throws)
      f.resource.health = async () => {
        f.state.probes++;
        throw new Error("DO_NOT_LEAK");
      };
    const events = [];
    const runtime = await selectStorage(
      settings(directory, {
        postgres: pgConfig,
        logger: (_level, event) => events.push(event),
      }),
      f.make,
    );
    assert.equal(runtime.provider, "json");
    f.state.up = true;
    assert.equal(await runtime.health(new AbortController().signal), true);
    assert.equal(runtime.provider, "json");
    await runtime.close();
    await runtime.close();
    assert.equal(f.state.closes, 1);
    assert.equal(f.state.probes, 1);
    assert.equal(f.state.queries.length, 0);
    assert.ok(!JSON.stringify(events).includes("DO_NOT_LEAK"));
  }
});

test("startup deadline aborts a stalled probe; late cleanup is owned without delaying JSON startup", async (t) => {
  const { directory } = await jsonFixture(t);
  const f = fakePostgres();
  let signal, finishClose;
  f.resource.health = (value) => {
    signal = value;
    return new Promise(() => {});
  };
  f.resource.close = () => {
    f.state.closes++;
    return new Promise((resolve) => {
      finishClose = resolve;
    });
  };
  const runtime = await selectStorage(
    settings(directory, { postgres: pgConfig, startupTimeoutMs: 10 }),
    f.make,
  );
  assert.equal(runtime.provider, "json");
  assert.equal(signal.aborted, true);
  let closed = false;
  const closing = runtime.close().then(() => {
    closed = true;
  });
  await delay(0);
  assert.equal(closed, false);
  finishClose();
  await closing;
  await runtime.close();
  assert.equal(f.state.closes, 1);
});

test("selected PostgreSQL never uses JSON on later health/query errors and exposes a redacted error", async (t) => {
  const { directory } = await jsonFixture(t);
  const f = fakePostgres();
  const events = [];
  const runtime = await selectStorage(
    settings(directory, {
      postgres: pgConfig,
      logger: (_level, event) => events.push(event),
    }),
    f.make,
  );
  assert.equal(runtime.provider, "postgresql");
  f.state.up = false;
  assert.equal(await runtime.health(new AbortController().signal), false);
  await assert.rejects(
    runtime.repositories.companies.findById(a),
    (error) =>
      error instanceof PostgresStorageError &&
      !error.message.includes("DO_NOT_LEAK"),
  );
  assert.equal(runtime.provider, "postgresql");
  assert.equal(f.state.probes, 1);
  assert.equal(
    events.filter((event) => event.event === "storage.selected").length,
    1,
  );
  await runtime.close();
});

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
async function launch(t, environment) {
  const value = await port();
  const child = spawn(process.execPath, [entry], {
    env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      NODE_ENV: "test",
      API_HOST: "127.0.0.1",
      API_PORT: String(value),
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const closed = once(child, "close");
  const stop = async () => {
    if (child.exitCode === null) child.kill();
    await closed;
  };
  t.after(stop);
  let response;
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null, output);
    try {
      response = await fetch(`http://127.0.0.1:${value}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      break;
    } catch {
      await delay(20);
    }
  }
  assert.ok(response, output);
  return {
    response,
    output: () => output,
    stop,
    url: `http://127.0.0.1:${value}`,
  };
}

test("actual API startup exposes JSON provider for absent/refused PostgreSQL without leaking configuration", async (t) => {
  const { directory } = await jsonFixture(t);
  for (const database of [
    undefined,
    "postgresql://demo:DO_NOT_LEAK@127.0.0.1:1/demo",
  ]) {
    const child = await launch(t, {
      JSON_DATA_DIR: directory,
      ...(database
        ? { DATABASE_URL: database, PG_CONNECTION_TIMEOUT_MS: "50" }
        : {}),
    });
    const body = await child.response.json();
    assert.equal(child.response.status, 503); // ERP remains unconfigured.
    assert.deepEqual(body.error.details.storage, {
      status: "up",
      provider: "json",
    });
    assert.equal(body.error.details.erp.status, "unconfigured");
    assert.ok(
      !JSON.stringify({ body, output: child.output() }).includes("DO_NOT_LEAK"),
    );
    assert.ok(!JSON.stringify(body).includes(directory));
    assert.match(child.output(), /"storageProvider":"json"/);
    await child.stop();
  }
});

test("actual startup rejects invalid storage settings safely before listener/pool creation", () => {
  for (const environment of [
    { JSON_DATA_DIR: " DO_NOT_LEAK " },
    { STORAGE_STARTUP_TIMEOUT_MS: "DO_NOT_LEAK" },
  ]) {
    const child = spawnSync(process.execPath, [entry], {
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        NODE_ENV: "test",
        API_HOST: "127.0.0.1",
        API_PORT: "3000",
        ...environment,
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.equal(JSON.parse(child.stderr).reason, "invalid_environment");
    assert.ok(!child.stderr.includes("DO_NOT_LEAK"));
  }
});

test("health success and degraded envelopes expose only the selected provider, including HEAD", async (t) => {
  const app = createApp({
    logger: () => {},
    storageProvider: "json",
    healthChecks: { storage: async () => true, erp: async () => true },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}/health`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.storage, {
    status: "up",
    provider: "json",
  });
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

const real = {
  skip:
    !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
    "Set B2B_TEST_MIGRATIONS_DATABASE_URL to a disposable PostgreSQL database",
  timeout: 30000,
};
async function postgresFixture(t) {
  const config = parsePostgresEnvironment({
    DATABASE_URL: process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
  });
  assert.ok(config);
  const admin = new Client({ ...config, query_timeout: 0 });
  await admin.connect();
  const schema = `b2b_selection_${randomUUID().replaceAll("-", "")}`;
  let runtime, pool;
  t.after(async () => {
    try {
      await runtime?.close();
      await pool?.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  await runMigrations(
    admin,
    await loadMigrations(new URL("../migrations/", import.meta.url)),
  );
  const scoped = { ...config, options: `-c search_path=${schema}` };
  pool = new Pool(scoped);
  return {
    admin,
    pool,
    scoped,
    setRuntime(value) {
      runtime = value;
    },
  };
}
async function seedPostgres(client, data) {
  for (const row of data.companies)
    await client.query(
      "INSERT INTO companies (id,legal_name,trade_name,status,erp_customer_reference) VALUES($1,$2,$3,$4,$5)",
      [
        row.id,
        row.legalName,
        row.tradeName,
        row.status,
        row.erpCustomerReference,
      ],
    );
  for (const row of data.users)
    await client.query(
      "INSERT INTO users (id,company_id,display_name,role,status,email,password_hash) VALUES($1,$2,$3,$4,$5,$6,'synthetic-hash')",
      [
        row.id,
        row.companyId,
        row.displayName,
        row.role,
        row.status,
        `${row.id}@example.test`,
      ],
    );
  for (const row of data.products)
    await client.query(
      "INSERT INTO products (id,sku,erp_product_reference,name,selling_uom,minimum_order_quantity,active,default_price,currency,price_valid_from,price_valid_to) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        row.id,
        row.sku,
        row.name,
        row.sellingUom,
        row.minimumOrderQuantity,
        row.active,
        row.defaultPrice?.amount ?? null,
        row.defaultPrice?.currency ?? null,
        row.defaultPrice?.validFrom ?? null,
        row.defaultPrice?.validTo ?? null,
      ],
    );
  for (const row of data.customer_product_access)
    await client.query(
      "INSERT INTO customer_product_access(id,company_id,product_id,eligible) VALUES($1,$2,$3,$4)",
      [randomUUID(), row.companyId, row.productId, row.eligible],
    );
  for (const row of data.customer_product_prices)
    await client.query(
      "INSERT INTO customer_product_prices(id,company_id,product_id,amount,currency,valid_from,valid_to) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        randomUUID(),
        row.companyId,
        row.productId,
        row.price.amount,
        row.price.currency,
        row.price.validFrom,
        row.price.validTo,
      ],
    );
  for (const row of data.orders)
    await client.query(
      'INSERT INTO orders(id,company_id,order_number,created_by_user_id,created_at,order_status,integration_status,order_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,\'{"private":"DO_NOT_LEAK"}\')',
      [
        row.id,
        row.companyId,
        row.orderNumber,
        row.createdByUserId,
        row.createdAt,
        row.status,
        row.integrationStatus,
      ],
    );
}

test(
  "real PostgreSQL: all current read ports match JSON, including tenant pricing, exact decimals, ordering and empty pages",
  real,
  async (t) => {
    const f = await postgresFixture(t);
    const { store } = await jsonFixture(t);
    await seedPostgres(f.admin, dataset());
    const pg = createPostgresRepositories(f.pool, () => new Date(at)),
      json = createJsonRepositories(store, () => new Date(at));
    for (const scope of [a, b, { companyId: id(999) }]) {
      const upper = { companyId: scope.companyId.toUpperCase() };
      const pc = createCompanyQueries(pg.companies, pg.users),
        jc = createCompanyQueries(json.companies, json.users);
      assert.deepEqual(await pc.getProfile(upper), await jc.getProfile(upper));
      for (const userId of [id(11), id(21), id(31), id(999)])
        assert.deepEqual(
          await pc.getCustomerUser(scope, userId.toUpperCase()),
          await jc.getCustomerUser(scope, userId),
        );
      for (const productId of [id(101), id(103), id(104), id(999)])
        assert.deepEqual(
          await createCatalogQueries(pg.catalog).getProduct(scope, productId),
          await createCatalogQueries(json.catalog).getProduct(scope, productId),
        );
      for (const orderId of [id(201), id(203), id(999)])
        assert.deepEqual(
          await createOrderQueries(pg.orders).getOrder(scope, orderId),
          await createOrderQueries(json.orders).getOrder(scope, orderId),
        );
      for (const page of [
        { offset: 0, limit: 1 },
        { offset: 1, limit: 2 },
        { offset: 100, limit: 2 },
      ]) {
        assert.deepEqual(
          await pc.listCustomerUsers(scope, page),
          await jc.listCustomerUsers(scope, page),
        );
        assert.deepEqual(
          await pg.catalog.listEligible(scope, page),
          await json.catalog.listEligible(scope, page),
        );
        assert.deepEqual(
          await pg.orders.list(scope, page),
          await json.orders.list(scope, page),
        );
      }
    }
    const text = JSON.stringify(
      await pg.orders.list(a, { offset: 0, limit: 20 }),
    );
    assert.ok(!text.includes("DO_NOT_LEAK"));
    for (const clock of [
      "2026-10-29T11:59:59.999Z",
      "2026-10-30T00:00:00.000Z",
    ]) {
      assert.deepEqual(
        await createPostgresRepositories(
          f.pool,
          () => new Date(clock),
        ).catalog.listEligible(a, { offset: 0, limit: 20 }),
        await createJsonRepositories(
          store,
          () => new Date(clock),
        ).catalog.listEligible(a, { offset: 0, limit: 20 }),
      );
    }
  },
);

test(
  "real PostgreSQL: selector uses actual ports, schema loss stays PostgreSQL and recovers without fallback",
  real,
  async (t) => {
    const f = await postgresFixture(t);
    const { directory } = await jsonFixture(t);
    await seedPostgres(f.admin, dataset());
    const runtime = await selectStorage(
      settings(directory, { postgres: f.scoped, startupTimeoutMs: 1000 }),
    );
    f.setRuntime(runtime);
    assert.equal(runtime.provider, "postgresql");
    assert.equal(await runtime.health(new AbortController().signal), true);
    assert.equal(
      (await runtime.repositories.companies.findById(a)).legalName,
      "Company 1",
    );
    await f.admin.query(
      "ALTER TABLE customer_product_prices RENAME TO temporarily_unavailable_prices",
    );
    assert.equal(await runtime.health(new AbortController().signal), false);
    await assert.rejects(
      runtime.repositories.catalog.listEligible(a, { offset: 0, limit: 20 }),
      PostgresStorageError,
    );
    assert.equal(runtime.provider, "postgresql");
    await f.admin.query(
      "ALTER TABLE temporarily_unavailable_prices RENAME TO customer_product_prices",
    );
    assert.equal(await runtime.health(new AbortController().signal), true);
    await runtime.close();
    await runtime.close();
  },
);

test("SQL adapters reject invalid scopes/pages before I/O and bind caller values as parameters", async () => {
  const calls = [];
  const pg = createPostgresRepositories({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  });
  await assert.rejects(pg.companies.findById({ companyId: " " }), TypeError);
  await assert.rejects(pg.orders.list(a, { offset: -1, limit: 1 }), RangeError);
  assert.equal(calls.length, 0);
  const hostile = "not-a-uuid' OR true --";
  assert.equal(await pg.users.findCustomerById(a, hostile), null);
  assert.ok(!calls[0].sql.includes(hostile.toLowerCase()));
  assert.equal(calls[0].values[1], hostile.toLowerCase());
});

test("retirement failures are contained, redacted and still reported to shutdown", async (t) => {
  const { directory } = await jsonFixture(t);
  const f = fakePostgres(false);
  const events = [];
  f.resource.close = async () => {
    f.state.closes++;
    throw new Error("DO_NOT_LEAK_CLOSE");
  };
  const runtime = await selectStorage(
    settings(directory, {
      postgres: pgConfig,
      logger: (_level, event) => events.push(event),
    }),
    f.make,
  );
  await assert.rejects(runtime.close());
  assert.equal(f.state.closes, 1);
  assert.ok(events.some((event) => event.event === "storage.cleanup_failed"));
  assert.ok(!JSON.stringify(events).includes("DO_NOT_LEAK"));
});

test(
  "real API process: reachable empty PostgreSQL stays selected/unhealthy; migrated schema and recovery report honestly",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL &&
      "Set B2B_TEST_MIGRATIONS_CLI_DATABASE_URL to a disposable local cluster with CREATEDB",
    timeout: 30000,
  },
  async (t) => {
    const config = parsePostgresEnvironment({
      DATABASE_URL: process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL,
    });
    assert.ok(config);
    const admin = new Client({ ...config, query_timeout: 0 });
    await admin.connect();
    const name = `b2b_selection_cli_${randomUUID().replaceAll("-", "")}`;
    let created = false,
      inspect,
      child;
    t.after(async () => {
      try {
        await child?.stop();
        await inspect?.end();
        if (created) await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
    });
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    const url = new URL(process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL);
    url.pathname = `/${name}`;
    const { directory } = await jsonFixture(t);
    const env = { DATABASE_URL: url.toString(), JSON_DATA_DIR: directory };
    child = await launch(t, env);
    let body = await child.response.json();
    assert.deepEqual(body.error.details.storage, {
      status: "down",
      provider: "postgresql",
    });
    await child.stop();
    inspect = new Client({
      ...parsePostgresEnvironment({ DATABASE_URL: url.toString() }),
      query_timeout: 0,
    });
    await inspect.connect();
    await runMigrations(
      inspect,
      await loadMigrations(new URL("../migrations/", import.meta.url)),
    );
    await seedPostgres(inspect, dataset());
    child = await launch(t, env);
    body = await child.response.json();
    assert.deepEqual(body.error.details.storage, {
      status: "up",
      provider: "postgresql",
    });
    await inspect.query(
      "ALTER TABLE customer_product_prices RENAME TO unavailable_prices",
    );
    body = await (await fetch(child.url + "/health")).json();
    assert.deepEqual(body.error.details.storage, {
      status: "down",
      provider: "postgresql",
    });
    await inspect.query(
      "ALTER TABLE unavailable_prices RENAME TO customer_product_prices",
    );
    body = await (await fetch(child.url + "/health")).json();
    assert.deepEqual(body.error.details.storage, {
      status: "up",
      provider: "postgresql",
    });
    assert.match(child.output(), /"storageProvider":"postgresql"/);
    await child.stop();
  },
);
