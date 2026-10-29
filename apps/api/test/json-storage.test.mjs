import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { JsonFileStore } from "../dist/infrastructure/json/store.js";
import { JsonStorageError } from "../dist/infrastructure/json/models.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createCompanyQueries } from "../dist/services/company-queries.js";
import { createCatalogQueries } from "../dist/services/catalog-queries.js";
import { createOrderQueries } from "../dist/services/order-queries.js";

const id = (number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const a = { companyId: id(1) },
  b = { companyId: id(2) },
  absent = { companyId: id(3) };
const at = "2026-10-29T12:00:00.000Z";
const price = (amount, validFrom = null, validTo = null) => ({
  amount,
  currency: "AED",
  validFrom,
  validTo,
});
const profile = (companyId, name) => ({
  id: companyId,
  legalName: name,
  tradeName: name,
  status: "ACTIVE",
  erpCustomerReference: null,
});
const product = (number, overrides = {}) => ({
  id: id(number),
  sku: `SKU-${number}`,
  name: `Product ${number}`,
  sellingUom: "KG",
  minimumOrderQuantity: "0.125",
  active: true,
  defaultPrice: price("12.5000000000000000001"),
  ...overrides,
});
function dataset() {
  return {
    companies: [
      profile(b.companyId, "Company B"),
      profile(a.companyId, "Company A"),
    ],
    users: [
      {
        id: id(102),
        companyId: a.companyId,
        displayName: "Admin A",
        role: "CUSTOMER_ADMIN",
        status: "SUSPENDED",
      },
      {
        id: id(100),
        companyId: b.companyId,
        displayName: "Buyer B",
        role: "CUSTOMER_USER",
        status: "ACTIVE",
      },
      {
        id: id(101),
        companyId: a.companyId,
        displayName: "Buyer A",
        role: "CUSTOMER_USER",
        status: "ACTIVE",
      },
      {
        id: id(103),
        companyId: null,
        displayName: "Internal",
        role: "INTERNAL_ADMIN",
        status: "ACTIVE",
      },
      {
        id: id(104),
        companyId: null,
        displayName: "Sales",
        role: "SALES_STAFF",
        status: "ACTIVE",
      },
    ],
    products: [
      product(206),
      product(205, { defaultPrice: null }),
      product(204),
      product(203, { active: false }),
      product(202),
      product(201),
    ],
    customer_product_access: [
      ...[201, 202, 203, 205, 206].map((number) => ({
        companyId: a.companyId,
        productId: id(number),
        eligible: true,
      })),
      { companyId: a.companyId, productId: id(204), eligible: false },
      { companyId: b.companyId, productId: id(204), eligible: true },
    ],
    customer_product_prices: [
      {
        companyId: a.companyId,
        productId: id(202),
        price: price(
          "7.30",
          "2026-10-01T00:00:00.000Z",
          "2026-11-01T00:00:00.000Z",
        ),
      },
      { companyId: b.companyId, productId: id(201), price: price("0.01") },
      {
        companyId: a.companyId,
        productId: id(205),
        price: price("9.00", "2026-11-01T00:00:00.000Z"),
      },
      {
        companyId: a.companyId,
        productId: id(206),
        price: price("9.00", null, "2026-10-01T00:00:00.000Z"),
      },
    ],
    orders: [
      {
        id: id(303),
        companyId: a.companyId,
        orderNumber: "ORDER-3",
        createdByUserId: id(101),
        createdAt: "2026-10-28T00:00:00.000Z",
        status: "DELIVERED",
        integrationStatus: "SUCCESS",
      },
      {
        id: id(300),
        companyId: b.companyId,
        orderNumber: "ORDER-B",
        createdByUserId: id(100),
        createdAt: "2026-10-30T00:00:00.000Z",
        status: "CONFIRMED",
        integrationStatus: "SUCCESS",
      },
      {
        id: id(302),
        companyId: a.companyId,
        orderNumber: null,
        createdByUserId: id(101),
        createdAt: at,
        status: "DRAFT",
        integrationStatus: "NOT_SENT",
      },
      {
        id: id(301),
        companyId: a.companyId,
        orderNumber: "ORDER-1",
        createdByUserId: id(101),
        createdAt: at,
        status: "SUBMITTED",
        integrationStatus: "FAILED",
      },
    ],
  };
}
const safeError = (code) => (error) =>
  error instanceof JsonStorageError &&
  error.code === code &&
  !/DO_NOT_LEAK|b2b-json-/.test(error.message) &&
  error.cause === undefined;
async function fixture(t, populate = true) {
  const directory = await mkdtemp(join(tmpdir(), "b2b-json-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonFileStore(directory),
    data = dataset();
  if (populate)
    for (const [collection, rows] of Object.entries(data))
      await store.replace(collection, rows);
  return {
    directory,
    store,
    data,
    repos: createJsonRepositories(store, () => new Date(at)),
  };
}
const projected = (row, resolved = row.defaultPrice) => ({
  id: row.id,
  sku: row.sku,
  name: row.name,
  sellingUom: row.sellingUom,
  minimumOrderQuantity: row.minimumOrderQuantity,
  price: resolved
    ? { amount: resolved.amount, currency: resolved.currency }
    : null,
});

test("real JSON files preserve all collections, UUIDs and exact decimals across reopen", async (t) => {
  const f = await fixture(t);
  const reopened = new JsonFileStore(f.directory);
  for (const [collection, rows] of Object.entries(f.data)) {
    assert.deepEqual(await reopened.read(collection), rows);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(f.directory, `${collection}.json`), "utf8"),
      ),
      rows,
    );
  }
  assert.equal(
    (await reopened.read("products"))[0].minimumOrderQuantity,
    "0.125",
  );
  assert.equal(
    (await reopened.read("products"))[0].defaultPrice.amount,
    "12.5000000000000000001",
  );
});

test("all seven existing read operations work through injected application services", async (t) => {
  const { repos, data } = await fixture(t);
  const queries = {
    ...createCompanyQueries(repos.companies, repos.users),
    ...createCatalogQueries(repos.catalog),
    ...createOrderQueries(repos.orders),
  };
  assert.deepEqual(await queries.getProfile(a), data.companies[1]);
  assert.deepEqual(await queries.getCustomerUser(a, id(101)), data.users[2]);
  assert.deepEqual(
    await queries.getProduct(a, id(202)),
    projected(data.products[4], data.customer_product_prices[0].price),
  );
  assert.deepEqual(await queries.getOrder(a, id(301)), data.orders[3]);
  assert.deepEqual(
    (await queries.listCustomerUsers(a)).items.map((r) => r.id),
    [id(101), id(102)],
  );
  assert.deepEqual(
    (await queries.listProducts(a)).items.map((r) => r.id),
    [201, 202, 205, 206].map(id),
  );
  assert.deepEqual(
    (await queries.listOrders(a)).items.map((r) => r.id),
    [301, 302, 303].map(id),
  );
});

test("tenant predicates apply before lookup, counting and pagination; internal roles stay private", async (t) => {
  const { repos } = await fixture(t),
    page = { offset: 0, limit: 1 };
  assert.equal(await repos.users.findCustomerById(a, id(100)), null);
  assert.equal(await repos.users.findCustomerById(a, id(103)), null);
  assert.equal(await repos.users.findCustomerById(b, id(101)), null);
  assert.equal(await repos.orders.findById(a, id(300)), null);
  assert.equal(await repos.orders.findById(b, id(301)), null);
  assert.equal(await repos.catalog.findEligibleById(a, id(204)), null);
  assert.equal(await repos.catalog.findEligibleById(b, id(201)), null);
  assert.equal(await repos.catalog.findEligibleById(a, id(203)), null);
  assert.equal(await repos.companies.findById(absent), null);
  const results = await Promise.all([
    repos.users.listCustomers(a, page),
    repos.orders.list(a, page),
    repos.catalog.listEligible(a, page),
  ]);
  assert.deepEqual(
    results.map((r) => r.total),
    [2, 3, 4],
  );
  assert.deepEqual(
    results.map((r) => r.items[0].id),
    [101, 301, 201].map(id),
  );
  for (const read of [
    repos.users.listCustomers,
    repos.orders.list,
    repos.catalog.listEligible,
  ])
    assert.deepEqual(await read(absent, page), { items: [], total: 0 });
  assert.equal((await repos.catalog.listEligible(b, page)).total, 1);
});

test("stable pagination handles ties, end offsets and boundary limits", async (t) => {
  const { repos } = await fixture(t);
  for (const [read, total, middle] of [
    [repos.users.listCustomers, 2, 102],
    [repos.orders.list, 3, 302],
    [repos.catalog.listEligible, 4, 202],
  ]) {
    assert.equal(
      (await read(a, { offset: 1, limit: 1 })).items[0].id,
      id(middle),
    );
    assert.deepEqual(await read(a, { offset: 100, limit: 100 }), {
      items: [],
      total,
    });
    assert.equal(
      (await read(a, { offset: 0, limit: 100 })).items.length,
      total,
    );
  }
});

test("price resolution is customer-scoped, valid-window aware and does not invent a price", async (t) => {
  const { repos } = await fixture(t);
  assert.equal(
    (await repos.catalog.findEligibleById(a, id(201))).price.amount,
    "12.5000000000000000001",
  );
  assert.equal(
    (await repos.catalog.findEligibleById(a, id(202))).price.amount,
    "7.30",
  );
  assert.equal((await repos.catalog.findEligibleById(a, id(205))).price, null);
  assert.equal(
    (await repos.catalog.findEligibleById(a, id(206))).price.amount,
    "12.5000000000000000001",
  );
});

test("price windows include their start and exclude their end, including default candidates", async (t) => {
  const f = await fixture(t),
    start = "2026-10-29T12:00:00.000Z",
    end = "2026-10-29T13:00:00.000Z";
  await f.store.replace("customer_product_prices", [
    {
      companyId: a.companyId,
      productId: id(201),
      price: price("0.00", start, end),
    },
  ]);
  for (const [time, expected] of [
    ["2026-10-29T11:59:59.999Z", "12.5000000000000000001"],
    [start, "0.00"],
    ["2026-10-29T12:59:59.999Z", "0.00"],
    [end, "12.5000000000000000001"],
  ]) {
    const repos = createJsonRepositories(f.store, () => new Date(time));
    assert.equal(
      (await repos.catalog.findEligibleById(a, id(201))).price.amount,
      expected,
    );
  }
  await f.store.replace("products", [
    product(201, { defaultPrice: price("5.00", start, end) }),
  ]);
  await f.store.replace("customer_product_prices", []);
  assert.equal(
    (
      await createJsonRepositories(
        f.store,
        () => new Date(end),
      ).catalog.findEligibleById(a, id(201))
    ).price,
    null,
  );
  await assert.rejects(
    createJsonRepositories(f.store, () => new Date(NaN)).catalog.listEligible(
      a,
      { offset: 0, limit: 20 },
    ),
    TypeError,
  );
});

test("read projections exclude credentials, internal notes and raw integration errors", async (t) => {
  const f = await fixture(t);
  const users = f.data.users.map((row) => ({
    ...row,
    passwordHash: "DO_NOT_LEAK",
    refreshToken: "DO_NOT_LEAK",
  }));
  const orders = f.data.orders.map((row) => ({
    ...row,
    internalNotes: "DO_NOT_LEAK",
    erpError: "DO_NOT_LEAK",
  }));
  await writeFile(join(f.directory, "users.json"), JSON.stringify(users));
  await writeFile(join(f.directory, "orders.json"), JSON.stringify(orders));
  const results = await Promise.all([
    f.repos.users.listCustomers(a, { offset: 0, limit: 100 }),
    f.repos.orders.list(a, { offset: 0, limit: 100 }),
  ]);
  assert.ok(!JSON.stringify(results).includes("DO_NOT_LEAK"));
  assert.deepEqual(
    Object.keys(results[0].items[0]).sort(),
    ["id", "companyId", "displayName", "role", "status"].sort(),
  );
});

test("results and queued inputs are detached; reopening never shares an in-memory cache", async (t) => {
  const f = await fixture(t),
    rows = [profile(a.companyId, "Snapshot")];
  const writing = f.store.replace("companies", rows);
  rows[0].legalName = "MUTATED";
  rows.length = 0;
  await writing;
  const company = await f.repos.companies.findById(a);
  company.legalName = "MUTATED";
  const productRow = await f.repos.catalog.findEligibleById(a, id(201));
  productRow.price.amount = "0";
  const list = await f.repos.users.listCustomers(a, { offset: 0, limit: 20 });
  list.items[0].companyId = b.companyId;
  list.items.length = 0;
  assert.equal(
    (await new JsonFileStore(f.directory).read("companies"))[0].legalName,
    "Snapshot",
  );
  assert.equal(
    (await f.repos.catalog.findEligibleById(a, id(201))).price.amount,
    "12.5000000000000000001",
  );
  assert.equal(
    (await f.repos.users.listCustomers(a, { offset: 0, limit: 20 })).total,
    2,
  );
  const scope = { ...a },
    request = { offset: 0, limit: 1 };
  const reading = f.repos.orders.list(scope, request);
  scope.companyId = b.companyId;
  request.offset = 2;
  assert.equal((await reading).items[0].id, id(301));
});

test("invalid scope and page inputs reject before missing-file I/O", async (t) => {
  const { repos } = await fixture(t, false);
  for (const scope of [
    undefined,
    null,
    {},
    { companyId: " " },
    { companyId: 1 },
  ]) {
    for (const read of [
      repos.companies.findById,
      (s) => repos.users.findCustomerById(s, id(101)),
      (s) => repos.catalog.findEligibleById(s, id(201)),
      (s) => repos.orders.findById(s, id(301)),
    ])
      await assert.rejects(read(scope), TypeError);
  }
  for (const page of [
    null,
    {},
    { offset: -1, limit: 1 },
    { offset: 0, limit: 101 },
    { offset: 0, limit: 0 },
    { offset: 0.5, limit: 1 },
    { offset: Infinity, limit: 1 },
  ]) {
    for (const read of [
      repos.users.listCustomers,
      repos.catalog.listEligible,
      repos.orders.list,
    ])
      await assert.rejects(read(a, page), RangeError);
  }
});

test("malformed JSON, invalid UTF-8, non-array and schema-invalid reads are redacted failures", async (t) => {
  const f = await fixture(t);
  for (const contents of [
    '{"DO_NOT_LEAK":',
    Buffer.from([0xff]),
    "null",
    "{}",
    '[{"id":"DO_NOT_LEAK"}]',
  ]) {
    await writeFile(join(f.directory, "companies.json"), contents);
    await assert.rejects(
      f.repos.companies.findById(a),
      safeError("invalid_data"),
    );
  }
  await f.store.replace("companies", f.data.companies);
  assert.equal((await f.repos.companies.findById(a)).legalName, "Company A");
});

test("missing collection files and catalog dependencies never silently become empty results", async (t) => {
  const f = await fixture(t);
  await rm(join(f.directory, "orders.json"));
  await assert.rejects(
    f.repos.orders.findById(a, id(301)),
    safeError("read_failed"),
  );
  await assert.rejects(
    f.repos.orders.list(a, { offset: 0, limit: 20 }),
    safeError("read_failed"),
  );
  await rm(join(f.directory, "customer_product_prices.json"));
  await assert.rejects(
    f.repos.catalog.findEligibleById(a, id(201)),
    safeError("read_failed"),
  );
  await assert.rejects(
    f.repos.catalog.listEligible(absent, { offset: 0, limit: 20 }),
    safeError("read_failed"),
  );
  assert.equal((await f.repos.companies.findById(a)).legalName, "Company A");
});

test("collection allowlist rejects paths and inherited object keys before filesystem use", async (t) => {
  const f = await fixture(t, false);
  for (const collection of [
    "../DO_NOT_LEAK",
    "__proto__",
    "toString",
    "companies.json",
    "",
    null,
  ]) {
    await assert.rejects(
      f.store.read(collection),
      safeError("invalid_collection"),
    );
    await assert.rejects(
      f.store.replace(collection, []),
      safeError("invalid_collection"),
    );
  }
  assert.deepEqual(await readdir(f.directory), []);
  assert.throws(() => new JsonFileStore(""), TypeError);
});

test("sparse replacement arrays are rejected without corrupting existing files", async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.directory, "companies.json"), "utf8");
  await assert.rejects(
    f.store.replace("companies", new Array(1)),
    safeError("invalid_data"),
  );
  const partial = [profile(a.companyId, "First")];
  partial.length = 2;
  await assert.rejects(
    f.store.replace("companies", partial),
    safeError("invalid_data"),
  );
  assert.equal(
    await readFile(join(f.directory, "companies.json"), "utf8"),
    before,
  );
});

test("invalid writes reject before publication and preserve the existing file", async (t) => {
  const f = await fixture(t),
    before = await readFile(join(f.directory, "products.json"), "utf8");
  for (const row of [
    product(201, { id: "DO_NOT_LEAK" }),
    product(201, { minimumOrderQuantity: "0" }),
    product(201, { minimumOrderQuantity: 0.125 }),
    product(201, { minimumOrderQuantity: "1e3" }),
    product(201, { defaultPrice: price("-1") }),
    product(201, { defaultPrice: { ...price("1"), currency: "aed" } }),
    product(201, { defaultPrice: price("1", "2026-02-30T00:00:00Z") }),
    product(201, { defaultPrice: price("1", at, at) }),
    product(201, { active: "true" }),
  ]) {
    await assert.rejects(
      f.store.replace("products", [row]),
      safeError("invalid_data"),
    );
  }
  assert.equal(
    await readFile(join(f.directory, "products.json"), "utf8"),
    before,
  );
  for (const collection of [
    "companies",
    "users",
    "products",
    "orders",
    "customer_product_access",
    "customer_product_prices",
  ]) {
    const row = f.data[collection][0];
    await assert.rejects(
      f.store.replace(collection, [row, row]),
      safeError("invalid_data"),
    );
  }
  await assert.rejects(
    f.store.replace("users", [{ ...f.data.users[0], role: "INTERNAL_ADMIN" }]),
    safeError("invalid_data"),
  );
  await assert.rejects(
    f.store.replace("orders", [{ ...f.data.orders[0], status: "DO_NOT_LEAK" }]),
    safeError("invalid_data"),
  );
  await assert.rejects(
    f.store.replace("orders", [
      { ...f.data.orders[0], createdAt: "2026-10-28T01:00:00+01:00" },
    ]),
    safeError("invalid_data"),
  );
});

test("serialized whole-collection replacements publish complete JSON and leave no temporary files", async (t) => {
  const f = await fixture(t);
  const writes = Array.from({ length: 20 }, (_, i) =>
    f.store.replace("companies", [profile(a.companyId, `Version ${i}`)]),
  );
  const reading = (async () => {
    for (let i = 0; i < 20; i++) {
      const rows = await f.store.read("companies");
      assert.ok(
        rows.every((r) => r.id === a.companyId || r.id === b.companyId),
      );
      assert.equal(
        rows[0].legalName,
        "Version 19",
        "reads queue behind already requested replacements",
      );
    }
  })();
  // Settle every actor before teardown, including when a publication fails.
  const results = await Promise.allSettled([...writes, reading]);
  assert.ok(results.every((result) => result.status === "fulfilled"));
  assert.equal((await f.store.read("companies"))[0].legalName, "Version 19");
  assert.ok(
    (await readdir(f.directory)).every((name) => name.endsWith(".json")),
  );
});

test("real filesystem publication failure is redacted, cleans the temp file and does not poison later writes", async (t) => {
  const f = await fixture(t, false),
    target = join(f.directory, "companies.json");
  await mkdir(target);
  await writeFile(join(target, "sentinel"), "preserve");
  await assert.rejects(
    f.store.replace("companies", [profile(a.companyId, "Failed")]),
    safeError("write_failed"),
  );
  assert.equal(await readFile(join(target, "sentinel"), "utf8"), "preserve");
  assert.deepEqual(await readdir(f.directory), ["companies.json"]);
  await assert.rejects(f.store.read("companies"), safeError("read_failed"));
  await rm(target, { recursive: true });
  await f.store.replace("companies", [profile(a.companyId, "Recovered")]);
  assert.equal((await f.store.read("companies"))[0].legalName, "Recovered");
  const notDirectory = join(f.directory, "not-directory");
  await writeFile(notDirectory, "preserve");
  await assert.rejects(
    new JsonFileStore(notDirectory).replace("companies", []),
    safeError("write_failed"),
  );
  assert.equal(await readFile(notDirectory, "utf8"), "preserve");
});

test("an explicit empty replacement persists, but reads never initialize missing files", async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(f.store.read("companies"), safeError("read_failed"));
  assert.deepEqual(await readdir(f.directory), []);
  await f.store.replace("companies", []);
  assert.deepEqual(await new JsonFileStore(f.directory).read("companies"), []);
  assert.equal(await f.repos.companies.findById(a), null);
});

test("UUID casing is canonical across files, tenant scopes, lookup IDs and duplicate keys", async (t) => {
  const f = await fixture(t, false);
  const companyId = "ABCDEFAB-0000-4000-8000-000000000001";
  const userId = "ABCDEFAB-0000-4000-8000-000000000002";
  await f.store.replace("companies", [profile(companyId, "Canonical")]);
  await f.store.replace("users", [
    {
      id: userId,
      companyId,
      displayName: "Buyer",
      role: "CUSTOMER_USER",
      status: "ACTIVE",
    },
  ]);
  assert.equal(
    (await f.repos.companies.findById({ companyId })).id,
    companyId.toLowerCase(),
  );
  assert.equal(
    (
      await f.repos.users.findCustomerById(
        { companyId: companyId.toLowerCase() },
        userId,
      )
    ).id,
    userId.toLowerCase(),
  );
  await assert.rejects(
    f.store.replace("companies", [
      profile(companyId, "First"),
      profile(companyId.toLowerCase(), "Duplicate"),
    ]),
    safeError("invalid_data"),
  );
  await assert.rejects(
    f.store.replace("customer_product_access", [
      { companyId, productId: userId, eligible: true },
      {
        companyId: companyId.toLowerCase(),
        productId: userId.toLowerCase(),
        eligible: false,
      },
    ]),
    safeError("invalid_data"),
  );
});

test("TypeScript JSON adapters satisfy existing ports without adding business write methods", () => {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    path = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  const config = ts.readConfigFile(path, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    root,
    { noEmit: true, rootDir: root },
    path,
  );
  assert.deepEqual(parsed.errors, []);
  const program = ts.createProgram(
    [
      ...parsed.fileNames,
      fileURLToPath(new URL("./fixtures/json-storage.ts", import.meta.url)),
    ],
    parsed.options,
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getCanonicalFileName: (name) => name,
      getNewLine: () => "\n",
    }),
  );
});
