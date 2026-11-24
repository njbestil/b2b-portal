import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
let server,
  processingState,
  processingOrder,
  ProcessingClient,
  OrderProcessingStatus;
const company = "12345678-1234-4234-8234-123456789abc",
  id = "22345678-1234-4234-8234-123456789abc";
const user = {
  id,
  companyId: company,
  role: "CUSTOMER_ADMIN",
  displayName: "Synthetic buyer",
  mustChangePassword: false,
};
const row = (patch = {}) => ({
  id,
  companyId: company,
  orderNumber: "SYNTHETIC-ORDER",
  createdAt: "2026-11-24T12:00:00.000Z",
  status: "SUBMITTED",
  integrationStatus: "FAILED",
  ...patch,
});
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  ({ processingState, processingOrder, ProcessingClient } =
    await server.ssrLoadModule("/src/features/order-processing/api.ts"));
  ({ OrderProcessingStatus } = await server.ssrLoadModule(
    "/src/features/order-processing/ProcessingPage.tsx",
  ));
});
after(async () => server?.close());
test("business-friendly mapping covers finite states and never promises automatic uncertain recovery", () => {
  for (const integration of [
    "NOT_SENT",
    "PENDING",
    "PROCESSING",
    "SUCCESS",
    "FAILED",
    "RETRYING",
  ]) {
    for (const status of [
      "PENDING_CUSTOMER_CONFIRMATION",
      "SUBMITTED",
      "CONFIRMED",
      "FULFILLING",
      "DELIVERED",
      "CANCELLED",
      "REJECTED",
    ]) {
      const result = processingState(status, integration);
      assert.ok(result.title && result.message);
      assert.ok(
        !/ERP|OUTCOME_UNKNOWN|retry_count|automatically|SQL|timeout/i.test(
          JSON.stringify(result),
        ),
      );
    }
    assert.equal(processingState("DELIVERED", integration).title, "Delivered");
    assert.equal(
      processingState("FULFILLING", integration).title,
      "Preparing delivery",
    );
    assert.equal(processingState("CANCELLED", integration).title, "Cancelled");
  }
  assert.equal(
    processingState("SUBMITTED", "FAILED").title,
    "Processing delayed",
  );
  assert.match(
    processingState("SUBMITTED", "FAILED").message,
    /before placing it again/,
  );
  assert.throws(() => processingState("SUBMITTED", "PRIVATE_ERROR"), {
    code: "unavailable",
  });
  assert.throws(() => processingState("DRAFT", "NOT_SENT"), {
    code: "unavailable",
  });
});
test("projection removes private/provider data and rejects foreign companies and malformed records", () => {
  const result = processingOrder(
    row({
      error: "PRIVATE_ERROR",
      erpOrderId: "PRIVATE_REFERENCE",
      retryCount: 99,
    }),
    company,
  );
  assert.deepEqual(
    Object.keys(result).sort(),
    ["id", "number", "createdAt", "state"].sort(),
  );
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  for (const patch of [
    { companyId: id },
    { id: "not-an-id" },
    { createdAt: "today" },
    { orderNumber: "x".repeat(257) },
    { status: "INTERNAL_ERROR" },
  ])
    assert.throws(() => processingOrder(row(patch), company), {
      code: "unavailable",
    });
});
const response = (data, status = 200, type = "application/json") =>
  new Response(JSON.stringify({ success: true, requestId: id, data }), {
    status,
    headers: { "content-type": type },
  });
test("client derives company from normal customer identity and sends a cancellable read only", async () => {
  let request;
  const session = {
    async request(path, init) {
      request = { path, init };
      return response({ items: [row()], total: 1, offset: 20, limit: 20 });
    },
  };
  const signal = new AbortController().signal,
    result = await new ProcessingClient(session, user).list(20, signal);
  assert.equal(
    request.path,
    `/api/v1/companies/${company}/order-history?offset=20&limit=20`,
  );
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.signal, signal);
  assert.equal(result.items[0].state.title, "Processing delayed");
  for (const patch of [
    { role: "SALES_STAFF" },
    { role: "INTERNAL_ADMIN" },
    { companyId: null },
    { mustChangePassword: true },
  ])
    await assert.rejects(
      new ProcessingClient(
        {
          request() {
            assert.fail("must not read");
          },
        },
        { ...user, ...patch },
      ).list(0, signal),
      { code: "forbidden" },
    );
});
test("malformed envelopes, technical data and API failures stay generic", async () => {
  for (const reply of [
    () =>
      response({
        items: [row({ companyId: id })],
        total: 1,
        offset: 0,
        limit: 20,
      }),
    () => response({ items: [row(), row()], total: 2, offset: 0, limit: 20 }),
    () => response({ items: [], total: -1, offset: 0, limit: 20 }),
    () => response({ items: [], total: 0, offset: 20, limit: 20 }),
    () => response({ private: "PRIVATE_ERROR" }, 503),
    () => response({}, 200, "text/html"),
  ]) {
    const client = new ProcessingClient(
      {
        async request() {
          return reply();
        },
      },
      user,
    );
    await assert.rejects(
      client.list(0, new AbortController().signal),
      (e) => e.code === "unavailable" && !e.message.includes("PRIVATE"),
    );
  }
  const denied = new ProcessingClient(
    {
      async request() {
        return response({}, 403);
      },
    },
    user,
  );
  await assert.rejects(denied.list(0, new AbortController().signal), {
    code: "forbidden",
  });
});
test("rendered processing notice has customer text and accessible status, with no raw technical state", () => {
  const html = renderToStaticMarkup(
    createElement(OrderProcessingStatus, {
      order: processingOrder(row({ error: "PRIVATE_ERROR" }), company),
    }),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /Processing delayed/);
  assert.ok(!/PRIVATE|FAILED|ERP|retryCount/.test(html));
});
