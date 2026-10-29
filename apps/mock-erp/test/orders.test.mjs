import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { createOrderService, OrderError } from "../dist/orders.js";
import { orderErrorHandler } from "../dist/order-http.js";

function input(overrides = {}) {
  return {
    portalOrderId: randomUUID(),
    customerId: "DEMO-C001",
    items: [{ productId: "DEMO-P001", quantity: "2" }],
    ...overrides,
  };
}
const code = (expected) => (error) =>
  error instanceof OrderError && error.code === expected;

test("order creation retains a detached order; replay returns its original identity and timestamp", () => {
  const orders = createOrderService();
  const body = input();
  const expectedInput = structuredClone(body);
  const first = orders.create("first-key", body);
  assert.equal(first.created, true);
  assert.match(first.order.erpOrderId, /^[\da-f-]{36}$/);
  assert.equal(first.order.status, "created");
  assert.equal(
    new Date(first.order.createdAt).toISOString(),
    first.order.createdAt,
  );
  assert.deepEqual(first.order.items, body.items);
  const expectedOrder = structuredClone(first.order);
  body.items[0].quantity = "999";
  first.order.items[0].quantity = "888";
  first.order.erpOrderId = "client mutation";
  const replay = orders.create("first-key", expectedInput);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.order, expectedOrder);
  replay.order.items.pop();
  assert.deepEqual(
    orders.create("first-key", expectedInput).order,
    expectedOrder,
  );
  const second = orders.create("second-key", input());
  assert.notEqual(second.order.erpOrderId, expectedOrder.erpOrderId);
});

test("canonical UUIDs, decimal text and reordered lines replay without floating point loss", () => {
  const orders = createOrderService();
  const body = input({
    items: [
      { productId: "DEMO-P003", quantity: "999999999999.123456" },
      { productId: "DEMO-P001", quantity: "2.000000" },
    ],
  });
  const first = orders.create("canonical", body);
  const replay = orders.create("canonical", {
    ...body,
    portalOrderId: body.portalOrderId.toUpperCase(),
    items: [
      { quantity: "2", productId: "DEMO-P001" },
      { quantity: "999999999999.123456", productId: "DEMO-P003" },
    ],
  });
  assert.equal(replay.created, false);
  assert.deepEqual(replay.order, first.order);
  assert.deepEqual(
    first.order.items.map((row) => row.quantity),
    ["2", "999999999999.123456"],
  );
  assert.equal(
    orders.create(
      "fractional",
      input({
        items: [{ productId: "DEMO-P003", quantity: "0.500000" }],
      }),
    ).order.items[0].quantity,
    "0.5",
  );
});

test("changed valid payloads conflict, and another key cannot duplicate a portal order", () => {
  const orders = createOrderService();
  const body = input();
  const first = orders.create("key", body);
  for (const changed of [
    input(),
    { ...body, customerId: "DEMO-C002" },
    { ...body, items: [{ productId: "DEMO-P001", quantity: "3" }] },
    { ...body, items: [{ productId: "DEMO-P003", quantity: "2" }] },
  ]) {
    assert.throws(
      () => orders.create("key", changed),
      code("IDEMPOTENCY_CONFLICT"),
    );
  }
  assert.throws(
    () => orders.create("another-key", body),
    code("ORDER_ALREADY_EXISTS"),
  );
  assert.deepEqual(orders.create("key", body).order, first.order);
  // The rejected key has not been reserved.
  assert.equal(orders.create("another-key", input()).created, true);
});

test("invalid keys and bounded order shapes fail before reserving a key or order reference", () => {
  const orders = createOrderService();
  const body = input();
  for (const key of [
    undefined,
    null,
    "",
    " ",
    "x y",
    "x,y",
    "x\ny",
    "x".repeat(129),
  ]) {
    assert.throws(
      () => orders.create(key, body),
      code("INVALID_IDEMPOTENCY_KEY"),
    );
  }
  const invalid = [
    undefined,
    null,
    [],
    "secret",
    {},
    { ...body, portalOrderId: "not-a-uuid" },
    { ...body, customerId: "unknown-secret" },
    { ...body, extra: "secret" },
    { ...body, items: [] },
    { ...body, items: new Array(1) },
    { ...body, items: Array(101).fill(body.items[0]) },
    { ...body, items: [body.items[0], body.items[0]] },
    { ...body, items: [null] },
    { ...body, items: [{ ...body.items[0], extra: "secret" }] },
    { ...body, items: [{ productId: "unknown", quantity: "2" }] },
    { ...body, items: [{ productId: "DEMO-P004", quantity: "2" }] },
    ...[
      0,
      2,
      "0",
      "0.000000",
      "-1",
      "01",
      "1e2",
      "NaN",
      "1.",
      ".5",
      "1.1234567",
      "1000000000000",
      " 1",
    ].map((quantity) => ({
      ...body,
      items: [{ productId: "DEMO-P001", quantity }],
    })),
  ];
  for (const value of invalid) {
    assert.throws(
      () => orders.create("valid-key", value),
      code("INVALID_ORDER"),
    );
  }
  assert.equal(orders.create("valid-key", body).created, true);
  assert.equal(orders.create("x".repeat(128), input()).created, true);
  assert.equal(orders.create("constructor", input()).created, true);
});

test("capacity rejects new orders without evicting replay records; fresh services are isolated", () => {
  const orders = createOrderService();
  const body = input();
  const first = orders.create("first", body);
  for (let i = 1; i < 1000; i++) orders.create(`key-${i}`, input());
  assert.throws(
    () => orders.create("full", input()),
    code("ORDER_CAPACITY_REACHED"),
  );
  assert.deepEqual(orders.create("first", body), {
    created: false,
    order: first.order,
  });
  const restarted = createOrderService().create("first", body);
  assert.equal(restarted.created, true);
  assert.notEqual(restarted.order.erpOrderId, first.order.erpOrderId);
});

async function startApp(t) {
  const server = createApp().listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}/mock-erp/v1/orders`;
}
function post(url, key, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

test("HTTP concurrent identical submissions create exactly one order and replay all other results", async (t) => {
  const url = await startApp(t);
  const body = input();
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => post(url, "parallel", body)),
  );
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(responses.filter((r) => r.status === 200).length, 19);
  for (const response of responses) {
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  const orders = await Promise.all(responses.map((r) => r.json()));
  assert.ok(
    orders.every(
      (order) => JSON.stringify(order) === JSON.stringify(orders[0]),
    ),
  );
  const conflict = await post(url, "parallel", {
    ...body,
    customerId: "DEMO-C002",
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
  const duplicate = await post(url, "new-key", body);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "ORDER_ALREADY_EXISTS");
  const secondUrl = await startApp(t);
  const fresh = await post(secondUrl, "parallel", body);
  assert.equal(fresh.status, 201);
  assert.notEqual((await fresh.json()).erpOrderId, orders[0].erpOrderId);
});

test("HTTP conflicting concurrent submissions preserve the winner and never reserve rejected work", async (t) => {
  const url = await startApp(t);
  const bodies = [input(), input()];
  const results = await Promise.all(
    bodies.map((body) => post(url, "race", body)),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const winner = results.findIndex((r) => r.status === 201);
  const original = await results[winner].json();
  await results[1 - winner].json();
  const replay = await post(url, "race", bodies[winner]);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), original);
  const retryRejected = await post(url, "other-key", bodies[1 - winner]);
  assert.equal(retryRejected.status, 201);
  await retryRejected.json();
});

test("HTTP parser and validation errors are bounded, redacted and do not consume idempotency keys", async (t) => {
  const url = await startApp(t);
  for (const [headers, body, expected, expectedCode] of [
    [
      { "Content-Type": "text/plain" },
      "DO_NOT_LEAK",
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    ],
    [
      { "Content-Type": "application/json" },
      '{"DO_NOT_LEAK":',
      400,
      "INVALID_JSON",
    ],
    [
      { "Content-Type": "application/json" },
      JSON.stringify({ secret: "DO_NOT_LEAK" }),
      400,
      "INVALID_ORDER",
    ],
    [
      { "Content-Type": "application/json" },
      JSON.stringify({ secret: "DO_NOT_LEAK".repeat(4000) }),
      413,
      "PAYLOAD_TOO_LARGE",
    ],
    [
      { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      "DO_NOT_LEAK",
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    ],
    [
      { "Content-Type": "application/json; charset=iso-8859-1" },
      "DO_NOT_LEAK",
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    ],
  ]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": "not-consumed" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, expectedCode);
    assert.ok(!text.includes("DO_NOT_LEAK"));
    assert.ok(!text.includes("stack"));
  }
  const missingKey = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input()),
  });
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, "INVALID_IDEMPOTENCY_KEY");
  const valid = await post(url, "not-consumed", input());
  assert.equal(valid.status, 201);
  await valid.json();
});

test("unexpected errors are redacted and already-started responses delegate without rewriting", () => {
  for (const error of [new Error("DO_NOT_LEAK"), "DO_NOT_LEAK", null]) {
    let status;
    let body;
    const response = {
      headersSent: false,
      setHeader(name, value) {
        assert.equal(name, "Cache-Control");
        assert.equal(value, "no-store");
      },
      status(value) {
        status = value;
        return this;
      },
      json(value) {
        body = value;
      },
    };
    orderErrorHandler(error, {}, response, () => assert.fail("must respond"));
    assert.equal(status, 500);
    assert.deepEqual(body, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error.",
      },
    });
  }
  const error = new Error("DO_NOT_LEAK");
  let delegated;
  orderErrorHandler(error, {}, { headersSent: true }, (value) => {
    delegated = value;
  });
  assert.equal(delegated, error);
});
