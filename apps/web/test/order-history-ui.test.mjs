import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
let vite, api, view;
const company = "12345678-1234-4234-8234-123456789abc",
  id = "22345678-1234-4234-8234-123456789abc",
  product = "32345678-1234-4234-8234-123456789abc",
  user = {
    id,
    companyId: company,
    role: "CUSTOMER_ADMIN",
    mustChangePassword: false,
  };
const row = {
  id,
  companyId: company,
  orderNumber: "SAFE-ORDER",
  createdAt: "2026-11-27T10:00:00.000Z",
  status: "FULFILLING",
  integrationStatus: "FAILED",
  privateError: "PRIVATE_SENTINEL",
};
const snapshot = {
  submittedAt: "2026-11-27T10:01:00.000Z",
  submittedBy: {
    displayName: "Historic Buyer",
    role: "CUSTOMER_ADMIN",
    id: "PRIVATE",
  },
  delivery: {
    label: "Historic delivery",
    line1: "Historic address",
    contactName: null,
    contactPhone: null,
    id: "PRIVATE",
  },
  currency: "AED",
  total: "27.500000",
  items: [
    {
      itemId: id,
      productId: product,
      sku: "TEST-SKU",
      name: "Historical rice",
      sellingUom: "Bag",
      minimumOrderQuantity: "1",
      quantity: "1",
      unitPrice: "27.500000",
      currency: "AED",
      lineTotal: "27.5",
    },
  ],
};
before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  api = await vite.ssrLoadModule("/src/features/order-history/api.ts");
  view = await vite.ssrLoadModule(
    "/src/features/order-history/HistoryPage.tsx",
  );
});
after(() => vite?.close());
test("history filters preserve literal search/date/status semantics and reject invalid bounds", () => {
  const q = new URLSearchParams(
    api.historyQuery(
      {
        search: "A%_+ & order",
        from: "2026-11-01",
        to: "2026-11-27",
        status: "FULFILLING",
      },
      20,
    ),
  );
  assert.equal(q.get("search"), "A%_+ & order");
  assert.equal(q.get("offset"), "20");
  assert.equal(q.get("limit"), "20");
  for (const patch of [
    { from: "2026-02-30" },
    { from: "2026-11-28", to: "2026-11-27" },
    { status: "PRIVATE_FAILURE" },
    { search: "x\n" },
    { search: "x".repeat(129) },
  ])
    assert.throws(
      () => api.historyQuery({ ...api.emptyFilters, ...patch }, 0),
      { code: "invalid" },
    );
  assert.throws(() => api.historyQuery(api.emptyFilters, 100001), {
    code: "invalid",
  });
});
test("history/snapshot projections preserve exact immutable values, strip private fields and reject foreign/malformed data", () => {
  const order = api.historyOrder(row, company);
  assert.equal(order.state.title, "Preparing delivery");
  assert.ok(!JSON.stringify(order).includes("FAILED"));
  assert.ok(!JSON.stringify(order).includes("PRIVATE"));
  const s = api.historySnapshot(snapshot);
  assert.equal(s.total, "27.500000");
  assert.equal(s.items[0].unitPrice, "27.500000");
  assert.ok(!JSON.stringify(s).includes("PRIVATE"));
  assert.equal(api.historySnapshot(null), null);
  assert.throws(
    () => api.historyOrder({ ...row, companyId: product }, company),
    { code: "unavailable" },
  );
  for (const patch of [
    { currency: "ÅBC" },
    { items: [] },
    { total: 27.5 },
    { items: [{ ...snapshot.items[0], quantity: "0" }] },
  ])
    assert.throws(() => api.historySnapshot({ ...snapshot, ...patch }), {
      code: "unavailable",
    });
});
test("history details/timeline render recorded dates and available status without invented transitions or accounting", () => {
  const order = {
      ...api.historyOrder(row, company),
      snapshot: api.historySnapshot(snapshot),
    },
    html = renderToStaticMarkup(
      createElement(view.OrderHistoryDetails, { order }),
    );
  for (const text of [
    "Historical rice",
    "Historic address",
    "27.500000",
    "Items at submission",
    "Fulfilling",
    'aria-current="step"',
  ])
    assert.ok(html.includes(text));
  for (const privateText of [
    "PRIVATE",
    "Confirmed</strong>",
    "Expected 14",
    "Payment terms",
    "VAT",
  ])
    assert.ok(!html.includes(privateText));
  const legacy = renderToStaticMarkup(
    createElement(view.OrderHistoryDetails, {
      order: { ...order, snapshot: null },
    }),
  );
  assert.ok(legacy.includes("details are unavailable"));
  assert.ok(!legacy.includes("Historical rice"));
});
test("customer client sends scoped cancellable reads and explicit reorder only; unavailable data never becomes success", async () => {
  const calls = [],
    signal = new AbortController().signal,
    reply = (data) =>
      new Response(JSON.stringify({ success: true, requestId: id, data }), {
        headers: { "content-type": "application/json" },
      });
  let data = { items: [row], total: 1, offset: 0, limit: 20 };
  const session = {
      async request(path, init) {
        calls.push({ path, init });
        return reply(data);
      },
    },
    client = new api.HistoryClient(session, user);
  assert.equal((await client.list(api.emptyFilters, 0, signal)).total, 1);
  assert.ok(
    calls[0].path.startsWith(
      "/api/v1/companies/" + company + "/order-history?",
    ),
  );
  assert.equal(calls[0].init.signal, signal);
  assert.equal(calls[0].init.method, "GET");
  data = {
    draft: {
      id: product,
      companyId: company,
      createdByUserId: user.id,
      status: "DRAFT",
      integrationStatus: "NOT_SENT",
    },
  };
  assert.equal(await client.reorder(id, signal), product);
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.body, "{}");
  assert.equal(calls.length, 2);
  await assert.rejects(
    new api.HistoryClient(session, { ...user, role: "SALES_STAFF" }).list(
      api.emptyFilters,
      0,
      signal,
    ),
    { code: "forbidden" },
  );
  await assert.rejects(
    new api.HistoryClient(session, { ...user, mustChangePassword: true }).list(
      api.emptyFilters,
      0,
      signal,
    ),
    { code: "forbidden" },
  );
  data = {
    items: [{ ...row, companyId: product }],
    total: 1,
    offset: 0,
    limit: 20,
  };
  await assert.rejects(client.list(api.emptyFilters, 0, signal), {
    code: "unavailable",
  });
  await assert.rejects(
    new api.HistoryClient(
      {
        async request() {
          return new Response("<html>PRIVATE</html>", {
            headers: { "content-type": "text/html" },
          });
        },
      },
      user,
    ).list(api.emptyFilters, 0, signal),
    { code: "unavailable" },
  );
});
