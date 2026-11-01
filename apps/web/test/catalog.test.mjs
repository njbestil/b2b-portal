import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  CatalogClient,
  CatalogError,
  defaultQuery,
  parseQuery,
  queryParams,
  filteredQuery,
  createHttpCatalogAdapter,
} from "../src/features/catalog/api.ts";
import { SessionClient } from "../src/features/authentication/session.ts";

// Test-only producer projection: no product/price fixture enters the browser bundle.
const id = "12345678-1234-4234-8234-123456789abc";
const companyId = "22345678-1234-4234-8234-123456789abc";
const item = {
  id,
  sku: "SYN-001",
  name: "Synthetic tea",
  sellingUom: "case",
  minimumOrderQuantity: "0.125",
  price: { amount: "9007199254740993.1200", currency: "AED" },
  category: "Synthetic category",
  brand: "Synthetic brand",
  availableQuantity: null,
};
const signal = () => new AbortController().signal;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const ok = (data) =>
  new Response(JSON.stringify({ success: true, requestId: id, data }), {
    headers: { "content-type": "application/json" },
  });

test("catalogue query round-trips literal name/SKU, category and brand, resets paging, and refuses company overrides", () => {
  const query = parseQuery(
    new URLSearchParams(
      "search=SKU%25_&category=Tea&brand=Example&offset=40&limit=20",
    ),
  );
  assert.equal(query.search, "SKU%_");
  assert.deepEqual(parseQuery(queryParams(query)), query);
  assert.deepEqual(
    filteredQuery(query, { search: " tea ", category: "", brand: " brand " }),
    { ...defaultQuery, search: "tea", brand: "brand" },
  );
  for (const raw of [
    "offset=-1",
    "offset=1.5",
    "offset=9007199254740992",
    "limit=0",
    "limit=101",
    "search=a&search=b",
    "companyId=other",
    "role=INTERNAL_ADMIN",
    "search=%00",
    `brand=${"x".repeat(101)}`,
  ])
    assert.throws(() => parseQuery(new URLSearchParams(raw)), {
      code: "invalid",
    });
});
test("injectable adapter receives only catalogue filters/paging; exact decimals and unknown metadata are preserved", async () => {
  let received;
  const client = new CatalogClient({
    async list(query) {
      received = query;
      return {
        items: [
          {
            ...item,
            privateErpReference: "DO_NOT_PROJECT",
            category: undefined,
            brand: undefined,
          },
        ],
        total: 1,
      };
    },
    async detail() {
      return item;
    },
  });
  const result = await client.list(defaultQuery, signal());
  assert.deepEqual(Object.keys(received), [
    "search",
    "category",
    "brand",
    "offset",
    "limit",
  ]);
  assert.equal(result.items[0].price.amount, "9007199254740993.1200");
  assert.equal(result.items[0].minimumOrderQuantity, "0.125");
  assert.equal(result.items[0].category, null);
  assert.equal(result.items[0].brand, null);
  assert.equal(result.items[0].privateErpReference, undefined);
  assert.deepEqual(await client.detail(id, signal()), item);
});
test("missing price remains null; invalid products, counts, duplicate IDs and mismatched detail do not render as valid catalogue", async () => {
  const valid = new CatalogClient({
    async list() {
      return { items: [{ ...item, price: null }], total: 1 };
    },
    async detail() {
      return { ...item, price: null };
    },
  });
  assert.equal((await valid.list(defaultQuery, signal())).items[0].price, null);
  for (const result of [
    { items: [item], total: -1 },
    { items: [item], total: 0 },
    { items: [item, item], total: 2 },
    { items: [{ ...item, price: { amount: 1, currency: "AED" } }], total: 1 },
    { items: [{ ...item, minimumOrderQuantity: "0.000" }], total: 1 },
    { items: [{ ...item, availableQuantity: "-1" }], total: 1 },
    { items: Array.from({ length: 21 }, () => item), total: 21 },
  ]) {
    const client = new CatalogClient({
      async list() {
        return result;
      },
      async detail() {
        return { ...item, id: companyId };
      },
    });
    await assert.rejects(client.list(defaultQuery, signal()), {
      code: "unavailable",
    });
    await assert.rejects(client.detail(id, signal()), { code: "unavailable" });
  }
  const empty = new CatalogClient({
    async list() {
      return { items: [], total: 3 };
    },
    async detail() {
      return item;
    },
  });
  assert.deepEqual(
    await empty.list({ ...defaultQuery, offset: 20 }, signal()),
    { items: [], total: 3 },
  );
});
test("production default is unavailable and invalid detail never reaches an adapter", async () => {
  await assert.rejects(new CatalogClient().list(defaultQuery, signal()), {
    code: "unavailable",
  });
  await assert.rejects(new CatalogClient().detail(id, signal()), {
    code: "unavailable",
  });
  let called = false;
  const client = new CatalogClient({
    async list() {
      called = true;
      return {};
    },
    async detail() {
      called = true;
      return item;
    },
  });
  await assert.rejects(client.detail("../another-company", signal()), {
    code: "not-found",
  });
  assert.equal(called, false);
});
test("configured HTTP proposal reads standard envelopes with encoded filters and maps safe failures; HTML fallback cannot succeed", async () => {
  const calls = [];
  const adapter = createHttpCatalogAdapter(
    async (path, passedSignal) => {
      calls.push({ path, signal: passedSignal });
      return ok(
        path.includes("?") ? { items: [item], total: 1 } : { product: item },
      );
    },
    {
      list: "/api/v1/catalog/products",
      detail: (id) => `/api/v1/catalog/products/${id}`,
    },
  );
  const client = new CatalogClient(adapter);
  await client.list({ ...defaultQuery, search: "SKU%_&" }, signal());
  await client.detail(id, signal());
  assert.equal(calls[0].path, "/api/v1/catalog/products?search=SKU%25_%26");
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.ok(!calls[0].path.includes("companyId"));
  for (const [status, code] of [
    [400, "invalid"],
    [401, "session"],
    [403, "forbidden"],
    [404, "not-found"],
    [503, "unavailable"],
  ]) {
    const failed = new CatalogClient(
      createHttpCatalogAdapter(
        async () => new Response("DO_NOT_RENDER", { status }),
        {
          list: "/api/v1/catalog/products",
          detail: () => "/api/v1/catalog/products/test",
        },
      ),
    );
    await assert.rejects(
      failed.list(defaultQuery, signal()),
      (e) =>
        e instanceof CatalogError &&
        e.code === code &&
        !e.message.includes("DO_NOT_RENDER"),
    );
  }
  const html = new CatalogClient(
    createHttpCatalogAdapter(
      async () => new Response("<html>fallback</html>"),
      {
        list: "/api/v1/catalog/products",
        detail: () => "/api/v1/catalog/products/test",
      },
    ),
  );
  await assert.rejects(html.list(defaultQuery, signal()), {
    code: "unavailable",
  });
});
test("resource cancels obsolete filtering and prevents late results after navigation/unmount", async () => {
  const resource = new CatalogResource(),
    slow = deferred(),
    fast = deferred();
  let previousSignal;
  const first = resource.load((s) => {
    previousSignal = s;
    return slow.promise;
  });
  assert.equal(resource.snapshot().kind, "loading");
  const second = resource.load(() => fast.promise);
  assert.equal(previousSignal.aborted, true);
  fast.resolve({ items: [item], total: 1 });
  await second;
  slow.resolve({ items: [], total: 0 });
  await first;
  assert.equal(resource.snapshot().data.total, 1);
  const abandoned = deferred(),
    last = resource.load(() => abandoned.promise);
  resource.cancel();
  abandoned.resolve({ items: [item], total: 20 });
  await last;
  assert.equal(resource.snapshot().kind, "loading");
  await resource.load(async () => {
    throw new Error("DO_NOT_RENDER");
  });
  assert.equal(
    resource.snapshot().error.message,
    "Catalog could not be loaded.",
  );
});

let server, CatalogView, ProductView, App, CatalogResource;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  ({ CatalogView, ProductView } = await server.ssrLoadModule(
    "/src/features/catalog/CatalogPage.tsx",
  ));
  ({ App } = await server.ssrLoadModule("/src/app.tsx"));
  ({ CatalogResource } = await server.ssrLoadModule(
    "/src/features/catalog/resource.ts",
  ));
});
after(async () => server?.close());
const render = (Component, props, path = "/catalog") =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(Component, props),
    ),
  );
const view = (state) =>
  render(CatalogView, {
    query: defaultQuery,
    state,
    apply() {},
    page() {},
    clear() {},
    retry() {},
  });
test("catalogue renders accessible filters, real detail links, exact price/MOQ, unknown stock and inactive previous paging", () => {
  const html = view({ kind: "ready", data: { items: [item], total: 1 } });
  for (const name of ["search", "category", "brand"])
    assert.ok(html.includes(`name="${name}"`));
  for (const match of html.matchAll(/<input[^>]*id="([^"]+)"/g))
    assert.ok(html.includes(`for="${match[1]}"`));
  assert.ok(html.includes("9007199254740993.1200"));
  assert.ok(html.includes("0.125 case"));
  assert.ok(html.includes(`/catalog/${id}`));
  assert.ok(html.includes("Not supplied"));
  assert.match(html, /aria-disabled="true"/);
  assert.ok(!html.includes('disabled=""'));
  assert.ok(!html.includes("Add to order"));
  assert.ok(!html.includes("Recommended"));
  const escaped = view({
    kind: "ready",
    data: { items: [{ ...item, name: "<script>unsafe</script>" }], total: 1 },
  });
  assert.ok(escaped.includes("&lt;script&gt;unsafe&lt;/script&gt;"));
  assert.ok(!escaped.includes("<script>unsafe</script>"));
  assert.match(html, /role="status"/);
});
test("loading, empty, beyond-end, failure and null-price detail states are truthful and safe", () => {
  assert.ok(view({ kind: "loading" }).includes("Loading company products"));
  assert.ok(
    view({ kind: "ready", data: { items: [], total: 0 } }).includes(
      "No products match",
    ),
  );
  assert.ok(
    view({ kind: "ready", data: { items: [], total: 2 } }).includes(
      "No products on this page",
    ),
  );
  const failed = view({
    kind: "error",
    error: new CatalogError("unavailable"),
  });
  assert.ok(failed.includes("catalogue is unavailable"));
  assert.ok(!failed.includes("DO_NOT_RENDER"));
  const html = render(ProductView, {
    state: {
      kind: "ready",
      data: { ...item, price: null, name: "<script>unsafe</script>" },
    },
    back: "/catalog?search=tea",
    retry() {},
  });
  assert.ok(html.includes("Price unavailable"));
  assert.ok(!html.includes("AED 0"));
  assert.ok(html.includes("Ordering requires a confirmed account price"));
  assert.ok(!html.includes("Add to order"));
  assert.ok(html.includes('href="/catalog?search=tea"'));
});
test("actual routes cannot fetch or render fixture data from a preview role; real customer identity reaches a loading catalogue", async () => {
  let calls = 0;
  const catalog = {
    async list() {
      calls++;
      return { items: [item], total: 1 };
    },
    async detail() {
      calls++;
      return item;
    },
  };
  for (const path of ["/catalog", `/catalog/${id}`]) {
    const html = render(App, { initialRole: "Customer Admin", catalog }, path);
    assert.ok(html.includes("approved customer account"));
    assert.ok(!html.includes("Synthetic tea"));
    assert.equal((html.match(/<main[\s>]/g) ?? []).length, 1);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  }
  assert.equal(calls, 0);
  const user = {
    id,
    companyId,
    displayName: "Synthetic Admin",
    role: "CUSTOMER_ADMIN",
    mustChangePassword: false,
  };
  const now = Date.now();
  const sessionClient = new SessionClient(
    async (path) =>
      ok(
        path.endsWith("login")
          ? {
              user,
              accessToken: "synthetic-access",
              refreshToken: "synthetic-refresh",
              tokenType: "Bearer",
              expiresIn: 900,
              refreshExpiresAt: new Date(now + 600000).toISOString(),
            }
          : { user },
      ),
    () => now,
  );
  await sessionClient.login("admin@example.test", "synthetic");
  assert.ok(
    render(App, { sessionClient, catalog }).includes(
      "Loading company products",
    ),
  );
});
