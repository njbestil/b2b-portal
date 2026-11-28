import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
let vite, ConfirmationClient, reviewView, ConfirmationContents, submissionQuote;
const id = "12345678-1234-4234-8234-123456789abc",
  contact = "22345678-1234-4234-8234-123456789abc",
  item = "32345678-1234-4234-8234-123456789abc";
const value = {
  canSubmit: false,
  confirmation: {
    id: contact,
    orderId: id,
    customerUserId: contact,
    status: "PENDING",
    createdAt: "2026-11-27T10:00:00.000Z",
  },
  order: {
    id,
    status: "PENDING_CUSTOMER_CONFIRMATION",
    createdBy: "Synthetic Sales",
    items: [
      {
        id: item,
        productId: item,
        quantity: "1.250000",
        name: "Synthetic rice",
        sku: "DEMO-RICE",
        sellingUom: "CASE",
      },
    ],
    delivery: { label: "Kitchen", line1: "Synthetic delivery" },
  },
};
before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  ({ ConfirmationClient, reviewView, submissionQuote } =
    await vite.ssrLoadModule("/src/features/customer-confirmations/api.ts"));
  ({ ConfirmationContents } = await vite.ssrLoadModule(
    "/src/features/customer-confirmations/ConfirmationPage.tsx",
  ));
});
after(async () => vite?.close());
const envelope = (data) =>
  new Response(JSON.stringify({ success: true, requestId: id, data }), {
    headers: { "content-type": "application/json" },
  });
test("confirmation review shows quantities/delivery and records no invented financial or ERP acceptance", () => {
  const projected = reviewView(
    {
      ...value,
      confirmation: { ...value.confirmation, fingerprint: "PRIVATE" },
      order: { ...value.order, internalNotes: "PRIVATE" },
    },
    id,
  );
  assert.deepEqual(projected, value);
  const html = renderToStaticMarkup(
    createElement(ConfirmationContents, { review: projected }),
  );
  assert.match(html, /1.250000/);
  assert.match(html, /Synthetic delivery/);
  assert.match(html, /before ERP submission/);
  assert.doesNotMatch(html, /PRIVATE|AED|Order confirmed/);
  for (const bad of [
    { ...value, order: { ...value.order, id: contact } },
    {
      ...value,
      confirmation: {
        ...value.confirmation,
        status: "CONFIRMED",
        reason: null,
        decidedAt: "2026-11-26T00:00:00.000Z",
      },
    },
    {
      ...value,
      order: {
        ...value.order,
        items: [{ ...value.order.items[0], quantity: "0" }],
      },
    },
  ])
    assert.throws(() => reviewView(bad, id));
});
test("confirmation client uses scoped cancellable reads and one explicit decision, denying other roles", async () => {
  const signal = new AbortController().signal,
    calls = [],
    user = {
      id: contact,
      companyId: id,
      role: "CUSTOMER_USER",
      mustChangePassword: false,
    };
  const client = new ConfirmationClient(
    {
      request: async (path, init) => {
        calls.push([path, init]);
        return envelope(
          init.method === "POST"
            ? {
                ...value,
                confirmation: {
                  ...value.confirmation,
                  status: "CONFIRMED",
                  decidedAt: "2026-11-27T10:01:00.000Z",
                  reason: null,
                },
              }
            : value,
        );
      },
    },
    user,
  );
  assert.deepEqual(await client.find(id, signal), value);
  assert.equal(
    (await client.decide(id, contact, "CONFIRMED", null, signal)).confirmation
      .status,
    "CONFIRMED",
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], `/api/v1/orders/${id}/confirmation`);
  assert.equal(calls[1][1].signal, signal);
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    confirmationId: contact,
    decision: "CONFIRMED",
    reason: null,
  });
  for (const role of ["SALES_STAFF", "INTERNAL_ADMIN"])
    assert.throws(() => new ConfirmationClient({}, { ...user, role }));
  await assert.rejects(client.decide(id, contact, "REJECTED", "", signal));
  const unavailable = new ConfirmationClient(
    { request: async () => new Response("PRIVATE", { status: 503 }) },
    user,
  );
  await assert.rejects(
    unavailable.decide(id, contact, "CONFIRMED", null, signal),
  );
});

test("assisted submission quote rejects malformed totals and client sends one explicit scoped submission", async () => {
  const q = {
    confirmationId: contact,
    token: "assisted-" + "a".repeat(64),
    currency: "AED",
    total: "27.5",
    items: [
      {
        itemId: item,
        name: "Synthetic rice",
        quantity: "1",
        sellingUom: "Case",
        unitPrice: "27.5",
        lineTotal: "27.5",
        currency: "AED",
      },
    ],
  };
  assert.deepEqual(submissionQuote(q, contact), q);
  for (const bad of [
    { ...q, token: "bad" },
    { ...q, total: "NaN" },
    { ...q, items: [] },
    { ...q, items: [...q.items, ...q.items] },
    { ...q, items: [{ ...q.items[0], currency: "USD" }] },
  ])
    assert.throws(() => submissionQuote(bad, contact));
  const calls = [];
  const client = new ConfirmationClient(
    {
      async request(path, init) {
        calls.push([path, init]);
        return envelope(
          path.endsWith("submission-quote") ? q : { orderId: id },
        );
      },
    },
    {
      id: contact,
      companyId: id,
      role: "CUSTOMER_USER",
      mustChangePassword: false,
    },
  );
  const signal = new AbortController().signal;
  const quote = await client.quote(id, contact, signal);
  assert.equal(calls.length, 1);
  await client.submit(id, quote, signal);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], "/api/v1/order-drafts/" + id + "/submit");
  assert.equal(calls[1][1].idempotencyKey, "assisted-confirmation");
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    confirmationId: contact,
    quoteToken: q.token,
  });
  const confirmed = {
    ...value,
    canSubmit: false,
    confirmation: {
      ...value.confirmation,
      status: "CONFIRMED",
      decidedAt: "2026-11-28T10:00:00.000Z",
      reason: null,
    },
    order: { ...value.order, status: "SUBMITTED" },
  };
  assert.equal(reviewView(confirmed, id).order.status, "SUBMITTED");
  assert.throws(() => reviewView({ ...confirmed, canSubmit: true }, id));
});
