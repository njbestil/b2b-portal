import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createCompanyQueries } from "../dist/services/company-queries.js";
import { createCatalogQueries } from "../dist/services/catalog-queries.js";
import { createOrderQueries } from "../dist/services/order-queries.js";

const scopeA = { companyId: "00000000-0000-4000-8000-000000000001" };
const scopeB = { companyId: "00000000-0000-4000-8000-000000000002" };
const company = {
  id: scopeA.companyId,
  legalName: "Demo",
  tradeName: "Demo",
  status: "ACTIVE",
  erpCustomerReference: null,
};
const user = {
  id: "user-a",
  companyId: scopeA.companyId,
  displayName: "Buyer",
  role: "CUSTOMER_USER",
  status: "ACTIVE",
};
const product = {
  id: "product-a",
  sku: "KG-1",
  name: "Bulk",
  sellingUom: "KG",
  minimumOrderQuantity: "0.125",
  price: { amount: "12.50", currency: "AED" },
};
const order = {
  id: "order-a",
  companyId: scopeA.companyId,
  orderNumber: null,
  createdByUserId: user.id,
  createdAt: "2026-10-29T00:00:00.000Z",
  status: "SUBMITTED",
  integrationStatus: "FAILED",
};

// Test-only port doubles, not evidence of real PostgreSQL/JSON adapter behavior.
function doubles(deferred = false) {
  const calls = [];
  function operation(name, result) {
    return async (...args) => {
      calls.push([name, ...structuredClone(args)]);
      if (deferred) await Promise.resolve();
      return structuredClone(result(...args));
    };
  }
  const inScope = (scope) => scope.companyId === scopeA.companyId;
  const list = (record, scope, page) => {
    const items = inScope(scope) ? [record] : [];
    return {
      items: items.slice(page.offset, page.offset + page.limit),
      total: items.length,
    };
  };
  return {
    calls,
    companies: {
      findById: operation("company", (scope) =>
        inScope(scope) ? company : null,
      ),
    },
    users: {
      findCustomerById: operation("user", (scope, id) =>
        inScope(scope) && id === user.id ? user : null,
      ),
      listCustomers: operation("users", (scope, page) =>
        list(user, scope, page),
      ),
    },
    catalog: {
      findEligibleById: operation("product", (scope, id) =>
        inScope(scope) && id === product.id ? product : null,
      ),
      listEligible: operation("products", (scope, page) =>
        list(product, scope, page),
      ),
    },
    orders: {
      findById: operation("order", (scope, id) =>
        inScope(scope) && id === order.id ? order : null,
      ),
      list: operation("orders", (scope, page) => list(order, scope, page)),
    },
  };
}

function services(ports) {
  return {
    ...createCompanyQueries(ports.companies, ports.users),
    ...createCatalogQueries(ports.catalog),
    ...createOrderQueries(ports.orders),
  };
}

for (const deferred of [false, true]) {
  test(`application services consume injected async ports (deferred=${deferred})`, async () => {
    const ports = doubles(deferred);
    const queries = services(ports);
    assert.deepEqual(await queries.getProfile(scopeA), company);
    assert.deepEqual(await queries.getCustomerUser(scopeA, user.id), user);
    assert.deepEqual(await queries.getProduct(scopeA, product.id), product);
    assert.deepEqual(await queries.getOrder(scopeA, order.id), order);
    assert.deepEqual(await queries.listCustomerUsers(scopeA), {
      items: [user],
      total: 1,
    });
    assert.deepEqual(await queries.listProducts(scopeA), {
      items: [product],
      total: 1,
    });
    assert.deepEqual(await queries.listOrders(scopeA), {
      items: [order],
      total: 1,
    });
    assert.deepEqual(ports.calls, [
      ["company", scopeA],
      ["user", scopeA, user.id],
      ["product", scopeA, product.id],
      ["order", scopeA, order.id],
      ["users", scopeA, { offset: 0, limit: 20 }],
      ["products", scopeA, { offset: 0, limit: 20 }],
      ["orders", scopeA, { offset: 0, limit: 20 }],
    ]);
  });
}

test("concurrent reads preserve each company scope and do not retry unscoped", async () => {
  const ports = doubles(true);
  const queries = services(ports);
  assert.deepEqual(
    await Promise.all([
      queries.getOrder(scopeA, order.id),
      queries.getOrder(scopeB, order.id),
      queries.getCustomerUser(scopeB, user.id),
      queries.getProduct(scopeB, product.id),
      queries.getProfile(scopeB),
      queries.listCustomerUsers(scopeB),
      queries.listProducts(scopeB),
      queries.listOrders(scopeB),
    ]),
    [
      order,
      null,
      null,
      null,
      null,
      { items: [], total: 0 },
      { items: [], total: 0 },
      { items: [], total: 0 },
    ],
  );
  assert.equal(ports.calls.length, 8);
  assert.deepEqual(
    ports.calls.map((call) => call[1]),
    [scopeA, ...Array(7).fill(scopeB)],
  );
});

test("missing records and pages beyond the end remain missing/empty", async () => {
  const queries = services(doubles());
  assert.equal(await queries.getCustomerUser(scopeA, "missing"), null);
  assert.equal(await queries.getProduct(scopeA, "missing"), null);
  assert.equal(await queries.getOrder(scopeA, "missing"), null);
  for (const read of [
    queries.listCustomerUsers,
    queries.listProducts,
    queries.listOrders,
  ]) {
    assert.deepEqual(await read(scopeA, { offset: 10, limit: 1 }), {
      items: [],
      total: 1,
    });
  }
});

test("invalid scopes and pagination are rejected before repository access", () => {
  const ports = doubles();
  const queries = services(ports);
  const reads = [
    (scope) => queries.getProfile(scope),
    (scope) => queries.getCustomerUser(scope, user.id),
    (scope) => queries.getProduct(scope, product.id),
    (scope) => queries.getOrder(scope, order.id),
    queries.listCustomerUsers,
    queries.listProducts,
    queries.listOrders,
  ];
  for (const read of reads) {
    for (const scope of [
      undefined,
      null,
      {},
      { companyId: "" },
      { companyId: " " },
      { companyId: 1 },
    ]) {
      assert.throws(() => read(scope), TypeError);
    }
  }
  for (const read of [
    queries.listCustomerUsers,
    queries.listProducts,
    queries.listOrders,
  ]) {
    for (const page of [
      null,
      {},
      { offset: -1, limit: 1 },
      { offset: 0.5, limit: 1 },
      { offset: Infinity, limit: 1 },
      { offset: Number.MAX_SAFE_INTEGER + 1, limit: 1 },
      { offset: 0, limit: 0 },
      { offset: 0, limit: 101 },
      { offset: 0, limit: 1.5 },
      { offset: 0, limit: NaN },
    ]) {
      assert.throws(() => read(scopeA, page), RangeError);
    }
  }
  assert.deepEqual(ports.calls, []);
});

test("valid pagination boundaries pass detached logical inputs to ports", async () => {
  const ports = doubles();
  const queries = services(ports);
  const scope = { ...scopeA };
  const page = { offset: 0, limit: 100 };
  const result = queries.listOrders(scope, page);
  scope.companyId = scopeB.companyId;
  page.limit = 0;
  assert.deepEqual(await result, { items: [order], total: 1 });
  assert.deepEqual(ports.calls, [
    ["orders", scopeA, { offset: 0, limit: 100 }],
  ]);
  await queries.listProducts(scopeA, { offset: 0, limit: 1 });
  assert.deepEqual(ports.calls[1], [
    "products",
    scopeA,
    { offset: 0, limit: 1 },
  ]);
});

test("repository failures propagate without missing-result conversion or fallback", async () => {
  const failure = new Error("storage unavailable");
  const ports = doubles();
  const calls = [];
  const fail = async () => {
    calls.push("failed");
    throw failure;
  };
  for (const port of [
    ports.companies,
    ports.users,
    ports.catalog,
    ports.orders,
  ]) {
    for (const method of Object.keys(port)) port[method] = fail;
  }
  const queries = services(ports);
  for (const read of [
    () => queries.getProfile(scopeA),
    () => queries.getCustomerUser(scopeA, user.id),
    () => queries.getProduct(scopeA, product.id),
    () => queries.getOrder(scopeA, order.id),
    () => queries.listCustomerUsers(scopeA),
    () => queries.listProducts(scopeA),
    () => queries.listOrders(scopeA),
  ]) {
    await assert.rejects(read, (error) => error === failure);
  }
  assert.equal(calls.length, 7);
  assert.deepEqual(ports.calls, []);
});

test("TypeScript contracts accept structural doubles and reject unsafe shapes", () => {
  const apiRoot = fileURLToPath(new URL("../", import.meta.url));
  const configPath = fileURLToPath(
    new URL("../tsconfig.json", import.meta.url),
  );
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    apiRoot,
    { noEmit: true, rootDir: apiRoot },
    configPath,
  );
  assert.deepEqual(parsed.errors, []);
  const program = ts.createProgram(
    [
      ...parsed.fileNames,
      fileURLToPath(
        new URL("./fixtures/repository-contracts.ts", import.meta.url),
      ),
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

test("repository ports and application queries have no infrastructure imports", () => {
  // Enforce the local dependency boundary, not just a convention in documentation.
  for (const directory of ["repositories", "services"]) {
    const dir = new URL(`../src/${directory}/`, import.meta.url);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const source = ts.createSourceFile(
        name,
        readFileSync(new URL(name, dir), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const imports = source.statements.filter(ts.isImportDeclaration);
      for (const declaration of imports) {
        const target = declaration.moduleSpecifier.text;
        assert.ok(
          target.startsWith("./") || target.startsWith("../repositories/"),
          `${name}: unexpected dependency ${target}`,
        );
        if (directory === "repositories")
          assert.equal(declaration.importClause?.isTypeOnly, true);
      }
    }
  }
});
