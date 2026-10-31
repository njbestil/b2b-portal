import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { createOrderService } from "../dist/orders.js";

const input = () => ({
  portalOrderId: randomUUID(),
  customerId: "DEMO-C001",
  items: [{ productId: "DEMO-P001", quantity: "2" }],
});
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
function post(url, body, key, scenario) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...(scenario ? { "X-Mock-ERP-Scenario": scenario } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("only explicit completed fixtures have stable detached synthetic invoice metadata", () => {
  const orders = createOrderService(),
    body = input();
  const { order } = orders.create("completed", body, true);
  const invoice = orders.invoice(order.erpOrderId.toUpperCase());
  assert.deepEqual(invoice, {
    erpInvoiceReference: `MOCK-INV-${order.erpOrderId}`,
    erpOrderId: order.erpOrderId,
    portalOrderId: body.portalOrderId,
    customerId: body.customerId,
    invoiceNumber: `DEMO-${order.erpOrderId}`,
    status: "available",
    amount: "100.00",
    currency: "AED",
    issuedAt: order.createdAt,
    documentReference: `mock-invoice:${order.erpOrderId}`,
  });
  const original = structuredClone(invoice);
  invoice.amount = "0";
  invoice.customerId = "DEMO-C002";
  assert.deepEqual(orders.invoice(order.erpOrderId), original);
  assert.deepEqual(orders.create("completed", body, false).order, order);
  assert.deepEqual(orders.invoice(order.erpOrderId), original);
  const normal = input(),
    created = orders.create("ordinary", normal).order;
  assert.equal(orders.invoice(created.erpOrderId), null);
  orders.create("ordinary", normal, true);
  assert.equal(orders.invoice(created.erpOrderId), null);
  assert.equal(order.status, "created");
  assert.throws(() => orders.create("completed", input(), true), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.throws(() => orders.create("new-key", body, true), {
    code: "ORDER_ALREADY_EXISTS",
  });
});

test("completed HTTP creation/replay is concurrent-safe; metadata is no-store and process-local", async (t) => {
  const url = await serve(t),
    body = input(),
    key = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => post(url, body, key, "completed")),
  );
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(responses.filter((r) => r.status === 200).length, 11);
  const orders = await Promise.all(responses.map((r) => r.json()));
  for (const order of orders) assert.deepEqual(order, orders[0]);
  const invoiceUrl = `${url}/${orders[0].erpOrderId}/invoice`;
  const response = await fetch(invoiceUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const expected = await response.json();
  assert.equal(expected.invoice.portalOrderId, body.portalOrderId);
  for (const scenario of [
    undefined,
    "success",
    "completed",
    "unavailable",
    "timeout",
  ]) {
    const replay = await post(url, body, key, scenario);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), orders[0]);
    assert.deepEqual(await (await fetch(invoiceUrl)).json(), expected);
  }
  const restarted = await serve(t);
  assert.equal(
    (await fetch(`${restarted}/${orders[0].erpOrderId}/invoice`)).status,
    404,
  );
});

test("ordinary, malformed, unknown and failed orders do not gain invoices", async (t) => {
  const url = await serve(t),
    body = input(),
    key = randomUUID();
  const ordinary = await (await post(url, body, key)).json();
  assert.deepEqual(
    await (await fetch(`${url}/${ordinary.erpOrderId}/invoice`)).json(),
    { invoice: null },
  );
  await post(url, body, key, "completed");
  assert.deepEqual(
    await (await fetch(`${url}/${ordinary.erpOrderId}/invoice`)).json(),
    { invoice: null },
  );
  for (const [id, status, code] of [
    ["DO_NOT_LEAK", 400, "INVALID_ORDER_ID"],
    [randomUUID(), 404, "ORDER_NOT_FOUND"],
  ]) {
    const response = await fetch(`${url}/${id}/invoice`);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.text();
    assert.ok(result.includes(code));
    assert.ok(!result.includes("DO_NOT_LEAK"));
  }
  const recovery = input(),
    recoveryKey = randomUUID();
  assert.equal(
    (await post(url, recovery, recoveryKey, "unavailable")).status,
    503,
  );
  const completed = await post(url, recovery, recoveryKey, "completed");
  assert.equal(completed.status, 201);
  const order = await completed.json();
  assert.equal(
    (await (await fetch(`${url}/${order.erpOrderId}/invoice`)).json()).invoice
      .customerId,
    "DEMO-C001",
  );
  assert.equal(
    (await post(url, input(), randomUUID(), "COMPLETED")).status,
    400,
  );
});
