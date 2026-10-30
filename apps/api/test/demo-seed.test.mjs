import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client, Pool } from "pg";
import { createDemoData, demoId } from "../dist/demo/dataset.js";
import {
  checkedTarget,
  DemoSeedError,
  seedJson,
  seedPostgres,
} from "../dist/demo/seed.js";
import { JsonFileStore } from "../dist/infrastructure/json/store.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { collectionFiles } from "../dist/infrastructure/json/schema.js";

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "b2b-seed-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return {
    parent,
    directory: join(parent, "b2b_demo_test"),
    options: { mode: "seed", confirmTarget: "b2b_demo_test" },
  };
}
async function snapshot(directory) {
  return Promise.all(
    Object.values(collectionFiles).map((file) =>
      readFile(join(directory, file), "utf8"),
    ),
  );
}
const entry = fileURLToPath(new URL("../dist/demo.js", import.meta.url));
function cli(args, extra = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...extra,
    },
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
}

test("demo snapshot is deterministic, detached, synthetic and covers roles, tenants, pricing and independent statuses", () => {
  const first = createDemoData(),
    second = createDemoData();
  assert.deepEqual(first, second);
  assert.deepEqual(
    new Set(first.users.map((r) => r.role)),
    new Set([
      "INTERNAL_ADMIN",
      "SALES_STAFF",
      "CUSTOMER_ADMIN",
      "CUSTOMER_USER",
    ]),
  );
  assert.equal(first.companies.length, 2);
  assert.equal(first.orders[1].status, "SUBMITTED");
  assert.equal(first.orders[1].integrationStatus, "FAILED");
  first.products[0].name = "mutated";
  assert.notEqual(first.products[0].name, second.products[0].name);
  assert.ok(!JSON.stringify(second).includes("password"));
});
test("JSON seed/reopen/reset produces exactly the same snapshot, without hidden initialization", async (t) => {
  const { parent, directory, options } = await fixture(t);
  await seedJson(directory, options);
  const before = await snapshot(directory);
  const store = new JsonFileStore(directory);
  await store.replace("orders", []);
  await assert.rejects(seedJson(directory, options), DemoSeedError);
  await seedJson(directory, { ...options, mode: "reset" });
  assert.deepEqual(await snapshot(directory), before);
  for (const name of Object.keys(collectionFiles))
    assert.deepEqual(
      await new JsonFileStore(directory).read(name),
      createDemoData()[name],
    );
  assert.deepEqual(await readdir(parent), ["b2b_demo_test"]);
});
test("unsafe names, wrong confirmations, unmanaged files and unknown data cannot be reset", async (t) => {
  const { directory, options } = await fixture(t);
  for (const name of [
    "public",
    "postgres",
    "b2b_demo_",
    "../b2b_demo_x",
    "b2b_demo_A",
  ])
    assert.throws(
      () => checkedTarget(name, { ...options, confirmTarget: name }),
      DemoSeedError,
    );
  await seedJson(directory, options);
  const before = await snapshot(directory);
  await assert.rejects(
    seedJson(directory, { mode: "reset", confirmTarget: "DO_NOT_LEAK" }),
    (error) =>
      error instanceof DemoSeedError && !error.message.includes("DO_NOT_LEAK"),
  );
  await writeFile(join(directory, "unrelated.txt"), "keep");
  await assert.rejects(
    seedJson(directory, { ...options, mode: "reset" }),
    DemoSeedError,
  );
  assert.equal(
    await readFile(join(directory, "unrelated.txt"), "utf8"),
    "keep",
  );
  assert.deepEqual(await snapshot(directory), before);
});
test("concurrent JSON seeds serialize by exclusive target lock; only one publishes", async (t) => {
  const { parent, directory, options } = await fixture(t);
  const results = await Promise.allSettled([
    seedJson(directory, options),
    seedJson(directory, options),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.deepEqual(await readdir(parent), ["b2b_demo_test"]);
  assert.equal(
    (await new JsonFileStore(directory).read("companies")).length,
    2,
  );
});
test("actual demo CLI requires explicit targets, redacts failures and seeds/resets JSON", async (t) => {
  const { directory, options } = await fixture(t);
  for (const args of [
    [],
    ["seed", "--provider", "json", "--directory", directory],
    ["reset", "--provider", "postgresql", "--confirm-target", "postgres"],
    ["seed", "--provider", "DO_NOT_LEAK"],
  ]) {
    const result = cli(args, {
      DATABASE_URL: "postgresql://secret:DO_NOT_LEAK@127.0.0.1:1/postgres",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("DO_NOT_LEAK"));
  }
  const args = [
    "seed",
    "--provider",
    "json",
    "--directory",
    directory,
    "--confirm-target",
    options.confirmTarget,
  ];
  const seeded = cli(args);
  assert.equal(seeded.status, 0, seeded.stderr);
  assert.equal(JSON.parse(seeded.stdout).event, "demo.completed");
  const before = await snapshot(directory);
  args[0] = "reset";
  assert.equal(cli(args).status, 0);
  assert.deepEqual(await snapshot(directory), before);
});

const real = {
  skip: process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL
    ? false
    : "Set B2B_TEST_MIGRATIONS_CLI_DATABASE_URL for disposable local database tests",
  timeout: 30000,
};
async function database(t) {
  const url = new URL(process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL);
  const admin = new Client({ connectionString: url.href });
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
  const migration = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/migrate.js", import.meta.url))],
    {
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        DATABASE_URL: url.href,
      },
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    },
  );
  assert.equal(migration.status, 0, migration.stderr);
  return { url, client, pool, options: { mode: "seed", confirmTarget: name } };
}
test(
  "real PostgreSQL: explicit migration and CLI seed/reset reproduce JSON read-port behavior",
  real,
  async (t) => {
    const { url, client, pool, options } = await database(t);
    const args = [
      "seed",
      "--provider",
      "postgresql",
      "--confirm-target",
      options.confirmTarget,
    ];
    assert.equal(cli(args, { DATABASE_URL: url.href }).status, 0);
    const { directory, options: jsonOptions } = await fixture(t);
    await seedJson(directory, jsonOptions);
    const sql = createPostgresRepositories(pool),
      json = createJsonRepositories(new JsonFileStore(directory));
    for (const n of [1, 2]) {
      const scope = { companyId: demoId(n) },
        page = { offset: 0, limit: 100 };
      assert.deepEqual(
        await sql.companies.findById(scope),
        await json.companies.findById(scope),
      );
      assert.deepEqual(
        await sql.users.listCustomers(scope, page),
        await json.users.listCustomers(scope, page),
      );
      assert.deepEqual(
        await sql.users.findCustomerById(scope, demoId(30 + n)),
        await json.users.findCustomerById(scope, demoId(30 + n)),
      );
      assert.deepEqual(
        await sql.catalog.listEligible(scope, page),
        await json.catalog.listEligible(scope, page),
      );
      assert.deepEqual(
        await sql.catalog.findEligibleById(scope, demoId(101)),
        await json.catalog.findEligibleById(scope, demoId(101)),
      );
      assert.deepEqual(
        await sql.orders.list(scope, page),
        await json.orders.list(scope, page),
      );
      assert.deepEqual(
        await sql.orders.findById(scope, demoId(203)),
        await json.orders.findById(scope, demoId(203)),
      );
    }
    assert.equal(
      cli(args, { DATABASE_URL: url.href }).status,
      1,
      "seed cannot overwrite",
    );
    await client.query("UPDATE companies SET trade_name='edited'");
    args[0] = "reset";
    assert.equal(cli(args, { DATABASE_URL: url.href }).status, 0);
    assert.equal(
      (await sql.companies.findById({ companyId: demoId(1) })).tradeName,
      "Demo Trading 1",
    );
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM schema_migrations"))
        .rows[0].n,
      1,
    );
    assert.equal(
      (
        await client.query(
          "SELECT bool_and(password_hash='!DISABLED_DEMO_LOGIN!') AS disabled FROM users",
        )
      ).rows[0].disabled,
      true,
    );
  },
);
test(
  "real PostgreSQL: unmarked/nonempty/unknown tables refuse mutation and failed reset rolls back",
  real,
  async (t) => {
    const { client, options } = await database(t);
    await assert.rejects(
      seedPostgres(client, { ...options, mode: "reset" }),
      DemoSeedError,
    );
    await seedPostgres(client, options);
    await client.query("UPDATE companies SET trade_name='keep'");
    await client.query("CREATE TABLE unrelated(data text)");
    await assert.rejects(
      seedPostgres(client, { ...options, mode: "reset" }),
      DemoSeedError,
    );
    await client.query("DROP TABLE unrelated");
    await client.query(
      "ALTER TABLE products ADD CONSTRAINT demo_test_failure CHECK (sku <> 'DEMO-P001') NOT VALID",
    );
    await assert.rejects(
      seedPostgres(client, { ...options, mode: "reset" }),
      DemoSeedError,
    );
    assert.equal(
      (await client.query("SELECT trade_name FROM companies LIMIT 1")).rows[0]
        .trade_name,
      "keep",
    );
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM users")).rows[0].n,
      6,
    );
    await client.query(
      "ALTER TABLE products DROP CONSTRAINT demo_test_failure",
    );
    await seedPostgres(client, { ...options, mode: "reset" });
  },
);
