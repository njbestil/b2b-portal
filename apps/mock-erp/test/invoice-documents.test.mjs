import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { createOrderService } from "../dist/orders.js";
import {
  resolveInvoiceDocument,
  maximumInvoiceDocumentBytes,
} from "../dist/invoice-documents.js";
const orderInput = () => ({
  portalOrderId: randomUUID(),
  customerId: "DEMO-C001",
  items: [{ productId: "DEMO-P001", quantity: "2" }],
});
const id = "12345678-1234-4234-8234-123456789abc";
const invoice = {
  erpInvoiceReference: `MOCK-INV-${id}`,
  erpOrderId: id,
  portalOrderId: "12345678-1234-4234-8234-123456789def",
  customerId: "DEMO-C001",
  invoiceNumber: `DEMO-${id}`,
  status: "available",
  amount: "100.00",
  currency: "AED",
  issuedAt: "2026-11-01T00:00:00.000Z",
  documentReference: `mock-invoice:${id}`,
};
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
  return `http://127.0.0.1:${server.address().port}/mock-erp/v1`;
}
async function create(base, completed = true) {
  const response = await fetch(`${base}/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": randomUUID(),
      "X-Mock-ERP-Scenario": completed ? "completed" : "success",
      "X-Mock-ERP-Fulfillment-Scenario": "delivered",
    },
    body: JSON.stringify(orderInput()),
  });
  assert.equal(response.status, 201);
  return response.json();
}
const documentUrl = (base, reference) =>
  `${base}/invoice-documents/${encodeURIComponent(reference)}`;

test("document bytes are deterministic visibly synthetic exact metadata with safe filename and detached buffers", () => {
  const lookup = (found) => {
    assert.equal(found, id);
    return { ...invoice, privateSentinel: "DO_NOT_LEAK" };
  };
  const first = resolveInvoiceDocument(invoice.documentReference, lookup),
    text = first.bytes.toString("utf8");
  assert.ok(
    text.startsWith(
      "SYNTHETIC DEMO INVOICE REFERENCE\nNOT A TAX INVOICE - NO FINANCIAL AUTHORITY\n\n",
    ),
  );
  assert.deepEqual(JSON.parse(text.split("\n\n")[1]), invoice);
  assert.ok(!text.includes("DO_NOT_LEAK"));
  assert.ok(first.bytes.byteLength <= maximumInvoiceDocumentBytes);
  assert.equal(first.filename, `mock-invoice-${id}.txt`);
  const expected = Buffer.from(first.bytes);
  first.bytes.fill(0);
  assert.deepEqual(
    resolveInvoiceDocument(invoice.documentReference, lookup).bytes,
    expected,
  );
  assert.equal(invoice.amount, "100.00");
});

test("resolver rejects malformed/path/URL/unissued references before arbitrary lookup and enforces byte bounds", () => {
  let calls = 0;
  const lookup = () => {
    calls++;
    return invoice;
  };
  for (const value of [
    null,
    "",
    invoice.documentReference.toUpperCase(),
    "../secret",
    "https://example.test/private",
    `mock-invoice:${id}/../other`,
    "mock-invoice:bad",
    "file:///secret",
    "x".repeat(10000),
  ])
    assert.throws(() => resolveInvoiceDocument(value, lookup), {
      code: "INVALID_DOCUMENT_REFERENCE",
    });
  assert.equal(calls, 0);
  assert.throws(
    () => resolveInvoiceDocument(invoice.documentReference, () => null),
    { code: "INVOICE_DOCUMENT_NOT_FOUND" },
  );
  assert.throws(
    () =>
      resolveInvoiceDocument(invoice.documentReference, () => ({
        ...invoice,
        erpOrderId: randomUUID(),
      })),
    { code: "INVOICE_DOCUMENT_NOT_FOUND" },
  );
  assert.throws(
    () =>
      resolveInvoiceDocument(invoice.documentReference, () => ({
        ...invoice,
        documentReference: "other",
      })),
    { code: "INVOICE_DOCUMENT_NOT_FOUND" },
  );
  assert.throws(
    () =>
      resolveInvoiceDocument(invoice.documentReference, () => ({
        ...invoice,
        invoiceNumber: "🍎".repeat(1100),
      })),
    { code: "INVOICE_DOCUMENT_UNAVAILABLE" },
  );
});

test("HTTP download/HEAD/concurrency preserve invoice, order, fulfillment and cancellation correlations", async (t) => {
  const base = await serve(t),
    order = await create(base),
    invoiceResponse = await (
      await fetch(`${base}/orders/${order.erpOrderId}/invoice`)
    ).json();
  const expectedInvoice = invoiceResponse.invoice,
    url = documentUrl(base, expectedInvoice.documentReference);
  const expectedState = await (
    await fetch(`${base}/orders/${order.erpOrderId}/fulfillment`)
  ).json();
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => fetch(url)),
  );
  const bytes = await Promise.all(
    responses.map(async (response) => {
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("content-type"),
        "text/plain; charset=utf-8",
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(
        response.headers.get("content-disposition"),
        `attachment; filename="mock-invoice-${order.erpOrderId}.txt"`,
      );
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("etag"), null);
      assert.equal(response.headers.get("location"), null);
      const value = Buffer.from(await response.arrayBuffer());
      assert.equal(
        Number(response.headers.get("content-length")),
        value.byteLength,
      );
      assert.ok(value.byteLength <= 4096);
      return value;
    }),
  );
  for (const value of bytes) assert.deepEqual(value, bytes[0]);
  assert.deepEqual(
    JSON.parse(bytes[0].toString("utf8").split("\n\n")[1]),
    expectedInvoice,
  );
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(Number(head.headers.get("content-length")), bytes[0].byteLength);
  const cancellation = await fetch(
    `${base}/orders/${order.erpOrderId}/cancellations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        portalCancellationRequestId: randomUUID(),
        reason: "Synthetic only",
      }),
    },
  );
  assert.equal(cancellation.status, 201);
  assert.deepEqual(
    Buffer.from(await (await fetch(url)).arrayBuffer()),
    bytes[0],
  );
  assert.deepEqual(
    await (await fetch(`${base}/orders/${order.erpOrderId}/invoice`)).json(),
    invoiceResponse,
  );
  assert.deepEqual(
    await (
      await fetch(`${base}/orders/${order.erpOrderId}/fulfillment`)
    ).json(),
    expectedState,
  );
});

test("HTTP malformed/traversal/URI errors and absent/restarted invoices are safe without redirects or files", async (t) => {
  const base = await serve(t),
    ordinary = await create(base, false),
    completed = await create(base, true);
  for (const value of [
    "../DO_NOT_LEAK",
    "https://example.test/DO_NOT_LEAK",
    "file:///DO_NOT_LEAK",
    `mock-invoice:${ordinary.erpOrderId}/../DO_NOT_LEAK`,
    "mock-invoice:bad",
  ]) {
    const response = await fetch(documentUrl(base, value), {
      redirect: "manual",
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("location"), null);
    const text = await response.text();
    assert.ok(text.includes("INVALID_DOCUMENT_REFERENCE"));
    assert.ok(!text.includes("DO_NOT_LEAK"));
  }
  const uri = await fetch(`${base}/invoice-documents/%ZZ`, {
    redirect: "manual",
  });
  assert.equal(uri.status, 400);
  assert.equal((await uri.json()).error.code, "INVALID_DOCUMENT_REFERENCE");
  for (const reference of [
    `mock-invoice:${ordinary.erpOrderId}`,
    `mock-invoice:${randomUUID()}`,
  ]) {
    const response = await fetch(documentUrl(base, reference));
    assert.equal(response.status, 404);
    assert.equal(
      (await response.json()).error.code,
      "INVOICE_DOCUMENT_NOT_FOUND",
    );
  }
  const restarted = await serve(t);
  const missing = await fetch(
    documentUrl(restarted, `mock-invoice:${completed.erpOrderId}`),
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "INVOICE_DOCUMENT_NOT_FOUND");
});

test("document resolution never regenerates invoice identities or order state", () => {
  const orders = createOrderService(),
    body = orderInput(),
    order = orders.create("document", body, true, "fulfilling").order;
  const original = orders.invoice(order.erpOrderId),
    state = orders.fulfillment(order.erpOrderId);
  const first = resolveInvoiceDocument(
    original.documentReference,
    orders.invoice,
  );
  for (let n = 0; n < 100; n++)
    assert.deepEqual(
      resolveInvoiceDocument(original.documentReference, orders.invoice).bytes,
      first.bytes,
    );
  assert.deepEqual(
    orders.create("document", body, false, "delivered").order,
    order,
  );
  assert.deepEqual(orders.invoice(order.erpOrderId), original);
  assert.deepEqual(orders.fulfillment(order.erpOrderId), state);
});
