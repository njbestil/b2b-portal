import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createOrderService } from "../dist/orders.js";
import { parseFulfillmentScenario } from "../dist/fulfillment.js";
import { createApp } from "../dist/app.js";
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
function post(url, key, value, fulfillment, scenario) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": key,
      ...(fulfillment === undefined
        ? {}
        : { "X-Mock-ERP-Fulfillment-Scenario": fulfillment }),
      ...(scenario === undefined ? {} : { "X-Mock-ERP-Scenario": scenario }),
    },
    body: JSON.stringify(value),
  });
}

test("explicit state fixtures bind retained order/time; queries detach and replay never progresses them", () => {
  const orders = createOrderService();
  assert.equal(parseFulfillmentScenario(undefined), "confirmed");
  for (const state of ["confirmed", "fulfilling", "delivered"]) {
    const body = input(),
      key = randomUUID(),
      order = orders.create(key, body, false, state).order;
    const expected = {
      erpOrderId: order.erpOrderId,
      portalOrderId: body.portalOrderId,
      customerId: body.customerId,
      fulfillmentStatus: state,
      updatedAt: order.createdAt,
    };
    const found = orders.fulfillment(order.erpOrderId.toUpperCase());
    assert.deepEqual(found, expected);
    found.customerId = "MUTATED";
    assert.deepEqual(orders.fulfillment(order.erpOrderId), expected);
    orders.create(
      key,
      body,
      true,
      state === "confirmed" ? "delivered" : "confirmed",
    );
    assert.deepEqual(orders.fulfillment(order.erpOrderId), expected);
    assert.equal(orders.invoice(order.erpOrderId), null);
    assert.equal(order.status, "created");
  }
  const completed = orders.create("invoice", input(), true).order;
  assert.equal(
    orders.fulfillment(completed.erpOrderId).fulfillmentStatus,
    "confirmed",
  );
  assert.equal(orders.invoice(completed.erpOrderId).status, "available");
  for (const value of ["", "CONFIRMED", "confirmed,delivered", "DO_NOT_LEAK"])
    assert.throws(
      () => parseFulfillmentScenario(value),
      (e) =>
        e.code === "INVALID_FULFILLMENT_SCENARIO" &&
        !e.message.includes("DO_NOT_LEAK"),
    );
  assert.throws(() => orders.fulfillment("bad"), { code: "INVALID_ORDER_ID" });
  assert.throws(() => orders.fulfillment(randomUUID()), {
    code: "ORDER_NOT_FOUND",
  });
  const value = input();
  assert.throws(() => orders.create("invalid", value, false, "unknown"), {
    code: "INVALID_FULFILLMENT_SCENARIO",
  });
  assert.equal(orders.create("invalid", value).created, true);
});

test("bounded fulfillment lifetime follows order capacity and restart without query allocation or eviction", () => {
  const orders = createOrderService(),
    body = input(),
    first = orders.create("0", body, false, "delivered").order;
  for (let n = 1; n < 1000; n++) orders.create(String(n), input());
  for (let n = 0; n < 20; n++)
    assert.equal(
      orders.fulfillment(first.erpOrderId).fulfillmentStatus,
      "delivered",
    );
  assert.throws(() => orders.create("overflow", input()), {
    code: "ORDER_CAPACITY_REACHED",
  });
  assert.deepEqual(orders.create("0", body).order, first);
  assert.throws(() => createOrderService().fulfillment(first.erpOrderId), {
    code: "ORDER_NOT_FOUND",
  });
});

test("HTTP fixtures/replay/concurrency, failure recovery and stable safe queries preserve default order semantics", async (t) => {
  const url = await serve(t);
  for (const state of [undefined, "confirmed", "fulfilling", "delivered"]) {
    const body = input(),
      key = randomUUID();
    const response = await post(url, key, body, state);
    assert.equal(response.status, 201);
    const order = await response.json(),
      endpoint = `${url}/${order.erpOrderId}/fulfillment`;
    const query = await fetch(endpoint);
    assert.equal(query.status, 200);
    assert.equal(query.headers.get("cache-control"), "no-store");
    assert.equal(query.headers.get("access-control-allow-origin"), null);
    const expected = await query.json();
    assert.equal(expected.fulfillmentStatus, state ?? "confirmed");
    assert.equal(expected.portalOrderId, body.portalOrderId);
    const replay = await post(url, key, body, "delivered");
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), order);
    assert.deepEqual(await (await fetch(endpoint)).json(), expected);
    assert.equal((await fetch(endpoint, { method: "HEAD" })).status, 200);
  }
  const body = input(),
    key = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, n) =>
      post(url, key, body, n % 2 ? "delivered" : "fulfilling"),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  const rows = await Promise.all(responses.map((r) => r.json()));
  for (const row of rows) assert.deepEqual(row, rows[0]);
  const state = await (
    await fetch(`${url}/${rows[0].erpOrderId}/fulfillment`)
  ).json();
  assert.ok(["delivered", "fulfilling"].includes(state.fulfillmentStatus));
  const recovering = input(),
    recoveryKey = randomUUID();
  assert.equal(
    (await post(url, recoveryKey, recovering, "delivered", "unavailable"))
      .status,
    503,
  );
  assert.equal(
    (await post(url, recoveryKey, recovering, "fulfilling")).status,
    201,
  );
  const invalidBody = input(),
    invalidKey = randomUUID();
  const invalid = await post(url, invalidKey, invalidBody, "DO_NOT_LEAK");
  assert.equal(invalid.status, 400);
  assert.ok(!(await invalid.text()).includes("DO_NOT_LEAK"));
  assert.equal((await post(url, invalidKey, invalidBody)).status, 201);
  for (const [id, status] of [
    ["DO_NOT_LEAK", 400],
    [randomUUID(), 404],
  ]) {
    const response = await fetch(`${url}/${id}/fulfillment`);
    assert.equal(response.status, status);
    assert.ok(!(await response.text()).includes("DO_NOT_LEAK"));
  }
  const restarted = await serve(t);
  assert.equal(
    (await fetch(`${restarted}/${rows[0].erpOrderId}/fulfillment`)).status,
    404,
  );
});

test("fulfillment reads model unavailable/timeout/cancellation without mutating the fixture or invoice", async (t) => {
  const url = await serve(t),
    body = input();
  const order = await (
    await post(url, "read-failure", body, "delivered", "completed")
  ).json();
  const endpoint = `${url}/${order.erpOrderId}/fulfillment`,
    expected = await (await fetch(endpoint)).json(),
    invoice = await (await fetch(`${url}/${order.erpOrderId}/invoice`)).json();
  for (const [scenario, status, code] of [
    ["unavailable", 503, "ERP_UNAVAILABLE"],
    ["timeout", 504, "ERP_TIMEOUT"],
    ["DO_NOT_LEAK", 400, "INVALID_FULFILLMENT_SCENARIO"],
  ]) {
    const response = await fetch(endpoint, {
      headers: { "X-Mock-ERP-Scenario": scenario },
    });
    assert.equal(response.status, status);
    const text = await response.text();
    assert.ok(text.includes(code));
    assert.ok(!text.includes("DO_NOT_LEAK"));
  }
  const controller = new AbortController(),
    pending = fetch(endpoint, {
      headers: { "X-Mock-ERP-Scenario": "timeout" },
      signal: controller.signal,
    });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending);
  assert.deepEqual(await (await fetch(endpoint)).json(), expected);
  assert.deepEqual(
    await (await fetch(`${url}/${order.erpOrderId}/invoice`)).json(),
    invoice,
  );
});

test("explicit cancellation decisions do not implicitly progress a retained fulfillment fixture", async () => {
  const { createCancellationService } =
    await import("../dist/cancellations.js");
  const orders = createOrderService(),
    order = orders.create("orthogonal", input(), false, "fulfilling").order,
    state = orders.fulfillment(order.erpOrderId);
  const cancellations = createCancellationService(orders.findById);
  for (const outcome of ["approved", "rejected"])
    cancellations.create(
      randomUUID(),
      order.erpOrderId,
      { portalCancellationRequestId: randomUUID(), reason: "Synthetic test" },
      outcome,
    );
  assert.deepEqual(orders.fulfillment(order.erpOrderId), state);
  assert.equal(orders.findById(order.erpOrderId).status, "created");
});
