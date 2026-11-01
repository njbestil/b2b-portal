import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { createOrderService } from "../dist/orders.js";
import {
  createCancellationService,
  parseCancellationScenario,
} from "../dist/cancellations.js";

const orderInput = () => ({
  portalOrderId: randomUUID(),
  customerId: "DEMO-C001",
  items: [{ productId: "DEMO-P001", quantity: "2" }],
});
const body = () => ({
  portalCancellationRequestId: randomUUID(),
  reason: "  Synthetic change of plan  ",
});
function fixture() {
  const orders = createOrderService(),
    order = orders.create("order", orderInput(), true).order;
  return {
    orders,
    order,
    cancellations: createCancellationService(orders.findById),
  };
}
async function serve(t) {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}/mock-erp/v1/orders`;
}
function post(url, key, value, scenario, signal) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": key,
      ...(scenario === undefined
        ? {}
        : { "X-Mock-ERP-Cancellation-Scenario": scenario }),
    },
    body: JSON.stringify(value),
    signal,
  });
}
async function target(url) {
  const response = await post(url, randomUUID(), orderInput());
  assert.equal(response.status, 201);
  return (await response.json()).erpOrderId;
}

test("approved/rejected decisions bind retained order and reason; replay/detachment never alter order or invoice", () => {
  const { orders, order, cancellations } = fixture(),
    value = body(),
    invoice = orders.invoice(order.erpOrderId);
  const first = cancellations.create(
    "decision",
    order.erpOrderId.toUpperCase(),
    value,
  );
  assert.equal(first.created, true);
  const expected = structuredClone(first.cancellation);
  assert.equal(expected.portalOrderId, order.portalOrderId);
  assert.equal(expected.customerId, order.customerId);
  assert.equal(expected.reason, value.reason.trim());
  assert.equal(expected.outcome, "approved");
  assert.equal(expected.rejectionReason, null);
  assert.equal(new Date(expected.decidedAt).toISOString(), expected.decidedAt);
  assert.match(expected.erpCancellationId, /^[\da-f-]{36}$/);
  value.reason = "changed";
  first.cancellation.reason = "mutated response";
  const replay = cancellations.create(
    "decision",
    order.erpOrderId,
    {
      portalCancellationRequestId:
        expected.portalCancellationRequestId.toUpperCase(),
      reason: expected.reason,
    },
    "rejected",
  );
  assert.equal(replay.created, false);
  assert.deepEqual(replay.cancellation, expected);
  const rejected = cancellations.create(
    "reject",
    order.erpOrderId,
    body(),
    "rejected",
  ).cancellation;
  assert.equal(rejected.outcome, "rejected");
  assert.equal(
    rejected.rejectionReason,
    "Simulated ERP cancellation rejection.",
  );
  assert.deepEqual(orders.findById(order.erpOrderId), order);
  assert.deepEqual(orders.invoice(order.erpOrderId), invoice);
});

test("invalid reason/fields/keys/targets and conflicting request identities never publish a decision", () => {
  const { orders, order, cancellations } = fixture(),
    key = "key",
    value = body();
  for (const invalid of [
    null,
    [],
    {},
    { ...value, role: "INTERNAL_ADMIN" },
    { ...value, reason: " " },
    { ...value, reason: "x".repeat(501) },
    { ...value, reason: "x\0" },
    { ...value, reason: "x\ud800" },
    { ...value, portalCancellationRequestId: "bad" },
  ])
    assert.throws(() => cancellations.create(key, order.erpOrderId, invalid), {
      code: "INVALID_CANCELLATION",
    });
  assert.throws(
    () => cancellations.create("bad key", order.erpOrderId, value),
    { code: "INVALID_IDEMPOTENCY_KEY" },
  );
  assert.throws(() => cancellations.create(key, "bad", value), {
    code: "INVALID_ORDER_ID",
  });
  assert.throws(() => cancellations.create(key, randomUUID(), value), {
    code: "ORDER_NOT_FOUND",
  });
  const first = cancellations.create(key, order.erpOrderId, value);
  assert.throws(
    () =>
      cancellations.create(key, order.erpOrderId, {
        ...value,
        reason: "different",
      }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  const other = orders.create("other", orderInput()).order;
  assert.throws(() => cancellations.create(key, other.erpOrderId, value), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.throws(
    () => cancellations.create("new-key", order.erpOrderId, value),
    { code: "CANCELLATION_ALREADY_EXISTS" },
  );
  assert.deepEqual(
    cancellations.replay(key, order.erpOrderId, value),
    first.cancellation,
  );
  for (const scenario of ["", "Approved", "approved,rejected", "DO_NOT_LEAK"])
    assert.throws(
      () => parseCancellationScenario(scenario),
      (e) =>
        e.code === "INVALID_CANCELLATION_SCENARIO" &&
        !e.message.includes("DO_NOT_LEAK"),
    );
});

test("bounded cancellation ledger refuses new work without evicting replay and fresh instances forget decisions", () => {
  const { orders, order, cancellations } = fixture(),
    value = body();
  const first = cancellations.create("0", order.erpOrderId, value).cancellation;
  for (let n = 1; n < 1000; n++)
    cancellations.create(String(n), order.erpOrderId, body(), "rejected");
  assert.throws(
    () => cancellations.create("overflow", order.erpOrderId, body()),
    { code: "CANCELLATION_CAPACITY_REACHED" },
  );
  assert.deepEqual(cancellations.replay("0", order.erpOrderId, value), first);
  assert.equal(
    createCancellationService(orders.findById).replay(
      "0",
      order.erpOrderId,
      value,
    ),
    null,
  );
  assert.throws(() => createOrderService().findById(order.erpOrderId), {
    code: "ORDER_NOT_FOUND",
  });
});

test("HTTP concurrent replay retains one decision and fixed known scenarios cannot change it", async (t) => {
  const url = await serve(t),
    id = await target(url),
    endpoint = `${url}/${id}/cancellations`,
    value = body(),
    key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => post(endpoint, key, value)),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 200).length, 11);
  const rows = await Promise.all(results.map((r) => r.json()));
  for (const row of rows) assert.deepEqual(row, rows[0]);
  for (const scenario of ["approved", "rejected", "timeout", "unavailable"]) {
    const response = await post(endpoint, key, value, scenario);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), rows[0]);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  const rejected = await post(endpoint, randomUUID(), body(), "rejected");
  assert.equal(rejected.status, 201);
  assert.equal((await rejected.json()).outcome, "rejected");
  const conflict = await post(endpoint, key, { ...value, reason: "other" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
});

test("HTTP technical failure/timeout/cancellation reserve nothing and recovery creates one decision", async (t) => {
  const url = await serve(t),
    endpoint = `${url}/${await target(url)}/cancellations`;
  for (const [scenario, status, code] of [
    ["unavailable", 503, "ERP_UNAVAILABLE"],
    ["timeout", 504, "ERP_TIMEOUT"],
  ]) {
    const value = body(),
      key = randomUUID(),
      failed = await post(endpoint, key, value, scenario);
    assert.equal(failed.status, status);
    assert.equal((await failed.json()).error.code, code);
    assert.equal((await post(endpoint, key, value, "approved")).status, 201);
  }
  const value = body(),
    key = randomUUID(),
    controller = new AbortController();
  const pending = post(endpoint, key, value, "timeout", controller.signal);
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending);
  const recovered = await post(endpoint, key, value);
  assert.equal(recovered.status, 201);
  assert.equal((await post(endpoint, key, value)).status, 200);
});

test("HTTP validates bounded JSON/reason/target without reflecting input or issuing portal access", async (t) => {
  const url = await serve(t),
    endpoint = `${url}/${await target(url)}/cancellations`;
  for (const [value, scenario, code] of [
    [{ ...body(), reason: "" }, "approved", "INVALID_CANCELLATION"],
    [body(), "DO_NOT_LEAK", "INVALID_CANCELLATION_SCENARIO"],
  ]) {
    const response = await post(endpoint, randomUUID(), value, scenario);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.ok(text.includes(code));
    assert.ok(!text.includes("DO_NOT_LEAK"));
    assert.equal(response.headers.get("set-cookie"), null);
  }
  for (const [id, status] of [
    ["DO_NOT_LEAK", 400],
    [randomUUID(), 404],
  ]) {
    const response = await post(
      `${url}/${id}/cancellations`,
      randomUUID(),
      body(),
    );
    assert.equal(response.status, status);
    assert.ok(!(await response.text()).includes("DO_NOT_LEAK"));
  }
  for (const [text, headers, status] of [
    ["{", { "content-type": "application/json" }, 400],
    ["x".repeat(5000), { "content-type": "application/json" }, 413],
    ["{}", { "content-type": "text/plain" }, 415],
    [
      "{}",
      { "content-type": "application/json", "content-encoding": "gzip" },
      415,
    ],
  ]) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: text,
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
