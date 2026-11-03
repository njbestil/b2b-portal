import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../dist/app.js";

const body = () => ({
  externalRequestReference: "failure-" + randomUUID(),
  portalOrderId: randomUUID(),
  customerId: "DEMO-C001",
  items: [
    {
      productId: "DEMO-P001",
      quantity: "2.000000",
      sellingUom: "Bag",
      unitPrice: "27.500000",
      currency: "AED",
      snapshot: { sku: "DEMO-RICE-BAG", name: "Demo rice snapshot" },
    },
  ],
});
async function start(t) {
  const server = createApp().listen(0, "127.0.0.1");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port + "/mock-erp/v1";
  return {
    base,
    post: (input, scenario, signal) =>
      fetch(base + "/submissions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(scenario === undefined
            ? {}
            : { "X-Mock-ERP-Scenario": scenario }),
        },
        body: JSON.stringify(input),
        signal,
      }),
  };
}
const technical = [
  ["timeout", 504, "ERP_TIMEOUT"],
  ["unavailable", 503, "ERP_UNAVAILABLE"],
  ["temporary-server-failure", 500, "ERP_TEMPORARY_FAILURE"],
];
const permanent = [
  ["validation", "ERP_VALIDATION_FAILED"],
  ["credit-hold", "CREDIT_HOLD"],
  ["insufficient-stock", "INSUFFICIENT_STOCK"],
  ["invalid-item", "INVALID_ITEM"],
];
test("technical failures repeat with safe correlation and explicit recovery publishes exactly one order", async (t) => {
  const { post, base } = await start(t);
  const before = await (await fetch(base + "/master-data")).json();
  const unrelated = body();
  const existing = await (await post(unrelated)).json();
  const invoiceUrl = base + "/orders/" + existing.order.erpOrderId + "/invoice";
  const fulfillmentUrl =
    base + "/orders/" + existing.order.erpOrderId + "/fulfillment";
  const beforeFulfillment = await (await fetch(fulfillmentUrl)).json();
  for (const [scenario, status, code] of technical) {
    const input = body();
    let expected;
    for (let i = 0; i < 2; i++) {
      const response = await post(input, scenario);
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const value = await response.json();
      assert.deepEqual(value, {
        externalRequestReference: input.externalRequestReference,
        portalOrderId: input.portalOrderId,
        customerId: input.customerId,
        error: {
          code,
          message:
            scenario === "timeout"
              ? "Simulated ERP timeout."
              : scenario === "unavailable"
                ? "Simulated ERP temporarily unavailable."
                : "Simulated temporary ERP server failure.",
        },
      });
      if (expected) assert.deepEqual(value, expected);
      expected = value;
      assert.equal(value.outcome, undefined);
    }
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => post(input)),
    );
    assert.equal(responses.filter((r) => r.status === 201).length, 1);
    const values = await Promise.all(responses.map((r) => r.json()));
    for (const value of values) assert.deepEqual(value, values[0]);
    assert.deepEqual(values[0].order.items, input.items);
    for (const [later] of technical) {
      const replay = await post(input, later);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), values[0]);
    }
  }
  assert.deepEqual(await (await fetch(base + "/master-data")).json(), before);
  assert.deepEqual(await (await fetch(invoiceUrl)).json(), { invoice: null });
  assert.deepEqual(
    await (await fetch(fulfillmentUrl)).json(),
    beforeFulfillment,
  );
});
test("permanent outcomes are terminal business inputs and cannot be changed by a technical scenario", async (t) => {
  const { post } = await start(t);
  const retryableCodes = new Set(technical.map(([, , code]) => code));
  for (const [scenario, code] of permanent) {
    const input = body(),
      response = await post(input, scenario),
      value = await response.json();
    assert.equal(response.status, 200);
    assert.equal(value.outcome, "rejected");
    assert.equal(value.rejection.code, code);
    assert.equal(retryableCodes.has(code), false);
    for (const [technicalScenario] of technical) {
      const replay = await post(input, technicalScenario);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), value);
    }
    assert.deepEqual(await (await post(input)).json(), value);
  }
});
test("cancelled timeout publishes nothing; controls are explicit and malformed input never becomes a technical error", async (t) => {
  const { post } = await start(t),
    input = body();
  await assert.rejects(post(input, "timeout", AbortSignal.timeout(50)));
  const recovered = await post(input);
  assert.equal(recovered.status, 201);
  const expected = await recovered.json();
  for (const [scenario] of technical) {
    const malformed = await post(
      { ...body(), customerId: "DO_NOT_REFLECT" },
      scenario,
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "INVALID_SUBMISSION");
  }
  for (const scenario of ["", "TIMEOUT", "timeout,success", "DO_NOT_REFLECT"]) {
    const response = await post(body(), scenario);
    assert.equal(response.status, 400);
    const value = await response.json();
    assert.equal(value.error.code, "INVALID_SCENARIO");
    assert.ok(!JSON.stringify(value).includes("DO_NOT_REFLECT"));
  }
  const conflict = await post(
    { ...input, items: [{ ...input.items[0], quantity: "3" }] },
    "unavailable",
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(await (await post(input, "timeout")).json(), expected);
  const independent = await post(body());
  assert.equal(independent.status, 201);
});
