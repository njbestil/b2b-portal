import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createOrderService } from "../dist/orders.js";
import { createSubmissionService } from "../dist/submissions.js";
import { createApp } from "../dist/app.js";
const body = () => ({
  externalRequestReference: "demo-" + randomUUID(),
  portalOrderId: randomUUID(),
  customerId: "DEMO-C001",
  items: [
    {
      productId: "DEMO-P003",
      quantity: "0.500000",
      sellingUom: "KG",
      unitPrice: "8.250000",
      currency: "AED",
      snapshot: { sku: "DEMO-APPLE-KG", name: "Submitted apples" },
    },
  ],
});
test("acceptance retains exact commercial snapshots, correlation and detached immutable replay", () => {
  const orders = createOrderService(),
    service = createSubmissionService(orders),
    input = body(),
    expected = structuredClone(input);
  input.externalRequestReference = "x".repeat(128);
  expected.externalRequestReference = input.externalRequestReference;
  const first = service.submit(input, "success");
  assert.equal(first.created, true);
  assert.equal(first.receipt.outcome, "accepted");
  assert.deepEqual(first.receipt.order.items, expected.items);
  assert.equal(
    first.receipt.externalRequestReference,
    expected.externalRequestReference,
  );
  assert.equal(first.receipt.order.portalOrderId, input.portalOrderId);
  assert.equal(first.receipt.order.customerId, input.customerId);
  const retained = structuredClone(first.receipt);
  input.items[0].quantity = "99";
  first.receipt.order.items[0].snapshot.name = "mutation";
  assert.deepEqual(service.submit(expected, "credit-hold"), {
    created: false,
    receipt: retained,
  });
  assert.equal(orders.invoice(retained.order.erpOrderId), null);
  assert.equal(
    orders.fulfillment(retained.order.erpOrderId).fulfillmentStatus,
    "confirmed",
  );
  assert.equal(service.submit(body(), "success").receipt.outcome, "accepted");
});
test("terminal business outcomes replay across scenario changes without publishing orders", () => {
  for (const [scenario, code] of [
    ["validation", "ERP_VALIDATION_FAILED"],
    ["credit-hold", "CREDIT_HOLD"],
    ["insufficient-stock", "INSUFFICIENT_STOCK"],
    ["invalid-item", "INVALID_ITEM"],
  ]) {
    const orders = createOrderService(),
      service = createSubmissionService(orders),
      input = body();
    const rejected = service.submit(input, scenario);
    assert.equal(rejected.receipt.outcome, "rejected");
    assert.equal(rejected.receipt.rejection.code, code);
    assert.equal(rejected.receipt.portalOrderId, input.portalOrderId);
    assert.deepEqual(service.submit(input, "success"), {
      created: false,
      receipt: rejected.receipt,
    });
    // The rejection allocates no order/invoice/fulfillment record.
    const created = orders.create("probe", {
      portalOrderId: input.portalOrderId,
      customerId: input.customerId,
      items: [{ productId: "DEMO-P003", quantity: "0.5" }],
    });
    assert.equal(created.created, true);
    assert.equal(orders.invoice(created.order.erpOrderId), null);
  }
});
test("external reference conflicts and existing-order outcomes never create duplicates", () => {
  const orders = createOrderService(),
    service = createSubmissionService(orders),
    input = body();
  const first = service.submit(input, "success");
  const duplicate = { ...input, externalRequestReference: "another-reference" };
  const second = service.submit(duplicate, "success");
  assert.equal(second.receipt.outcome, "existing-order");
  assert.equal(second.receipt.order.erpOrderId, first.receipt.order.erpOrderId);
  assert.equal(second.receipt.externalRequestReference, "another-reference");
  assert.deepEqual(
    service.submit(duplicate, "invalid-item").receipt,
    second.receipt,
  );
  assert.throws(
    () => service.submit({ ...input, customerId: "DEMO-C002" }, "success"),
    (e) => e.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.throws(
    () =>
      service.submit(
        {
          ...duplicate,
          externalRequestReference: "changed",
          items: [{ ...input.items[0], quantity: "1" }],
        },
        "success",
      ),
    (e) => e.code === "ORDER_ALREADY_EXISTS",
  );
  assert.notEqual(
    service.submit(body(), "success").receipt.order.erpOrderId,
    first.receipt.order.erpOrderId,
  );
});
test("malformed shapes and exact decimal/snapshot constraints do not reserve references", () => {
  const service = createSubmissionService(createOrderService()),
    input = body();
  for (const malformed of [
    null,
    [],
    { ...input, extra: true },
    { ...input, externalRequestReference: " " },
    { ...input, customerId: "missing" },
    { ...input, items: [] },
    ...[
      { quantity: 1 },
      { quantity: "1e2" },
      { quantity: "0" },
      { quantity: "01" },
      { unitPrice: 8.25 },
      { unitPrice: "-1" },
      { sellingUom: "invalid" },
      { currency: "aed" },
      { snapshot: { sku: "x" } },
      { snapshot: { sku: "x", name: "x", secret: "x" } },
      { snapshot: { sku: "x", name: "\n" } },
      { productId: "missing" },
    ].map((patch) => ({ ...input, items: [{ ...input.items[0], ...patch }] })),
  ]) {
    assert.throws(
      () => service.submit(malformed, "success"),
      (e) => e.code === "INVALID_SUBMISSION",
    );
  }
  assert.equal(service.replay(input), null);
  assert.equal(service.submit(input, "success").created, true);
});
test("receipt capacity retains all replay identities and fresh instances are isolated", () => {
  const service = createSubmissionService(createOrderService()),
    first = body();
  const expected = service.submit(first, "validation").receipt;
  for (let i = 1; i < 1000; i++) service.submit(body(), "validation");
  assert.throws(
    () => service.submit(body(), "success"),
    (e) => e.code === "SUBMISSION_CAPACITY_REACHED",
  );
  assert.deepEqual(service.submit(first, "success").receipt, expected);
  assert.equal(
    createSubmissionService(createOrderService()).replay(first),
    null,
  );
});
test("HTTP concurrent submissions retain one order; business responses are safe correlated receipts", async (t) => {
  const server = createApp().listen(0, "127.0.0.1");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  await once(server, "listening");
  const url =
    "http://127.0.0.1:" + server.address().port + "/mock-erp/v1/submissions";
  const input = body(),
    post = (data, scenario) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(scenario ? { "X-Mock-ERP-Scenario": scenario } : {}),
        },
        body: JSON.stringify(data),
      });
  const replies = await Promise.all(
    Array.from({ length: 8 }, () => post(input)),
  );
  assert.equal(replies.filter((r) => r.status === 201).length, 1);
  const receipts = await Promise.all(replies.map((r) => r.json()));
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  const rejected = body(),
    response = await post(rejected, "invalid-item");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const receipt = await response.json();
  assert.equal(
    receipt.externalRequestReference,
    rejected.externalRequestReference,
  );
  assert.equal(receipt.rejection.code, "INVALID_ITEM");
  assert.deepEqual(await (await post(rejected)).json(), receipt);
  assert.equal((await post(input, "unknown-secret")).status, 400);
  const malformed = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(33000) }),
      })
    ).status,
    413,
  );
});
