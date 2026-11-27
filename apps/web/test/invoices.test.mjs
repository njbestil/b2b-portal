import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
let server, InvoiceClient, invoiceView, InvoiceDetails;
const id = "12345678-1234-4234-8234-123456789abc",
  orderId = "22345678-1234-4234-8234-123456789abc";
const row = {
  id,
  orderId,
  invoiceNumber: "MOCK-001",
  status: "available",
  amount: "123456789012345678901234.123456789012345678",
  currency: "AED",
  issuedAt: "2026-11-27T00:00:00.000Z",
  syncedAt: "2026-11-27T01:00:00.000Z",
  documentAvailable: true,
};
const user = {
  id,
  companyId: orderId,
  role: "CUSTOMER_ADMIN",
  mustChangePassword: false,
};
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  ({ InvoiceClient, invoiceView } = await server.ssrLoadModule(
    "/src/features/invoices/api.ts",
  ));
  ({ InvoiceDetails } = await server.ssrLoadModule(
    "/src/features/invoices/InvoicePage.tsx",
  ));
});
after(async () => server?.close());
const envelope = (data) =>
  new Response(JSON.stringify({ success: true, requestId: id, data }), {
    headers: { "content-type": "application/json" },
  });
test("invoice projections and detail keep exact decimal metadata and never invent payment or tax status", () => {
  const value = invoiceView({
    ...row,
    documentReference: "PRIVATE",
    erpInvoiceReference: "PRIVATE",
  });
  assert.deepEqual(value, row);
  const html = renderToStaticMarkup(
    createElement(InvoiceDetails, { invoice: value }),
  );
  assert.ok(html.includes(row.amount));
  assert.match(html, /Available/);
  assert.match(html, /No financial authority/);
  assert.doesNotMatch(html, /PRIVATE|Paid|Overdue|VAT|Due date/);
  for (const patch of [
    { amount: "1e3" },
    { currency: "aED" },
    { status: "paid" },
    { documentAvailable: "true" },
    { id: "bad" },
    { issuedAt: "bad" },
  ])
    assert.throws(() => invoiceView({ ...row, ...patch }));
});
test("invoice client scopes cancellable list/detail through normal session and validates paging and identity", async () => {
  const calls = [],
    signal = new AbortController().signal;
  const client = new InvoiceClient(
    {
      read: async (path, s) => {
        calls.push([path, s]);
        return envelope(
          path.includes("?")
            ? { items: [row], total: 1, offset: 0, limit: 20 }
            : row,
        );
      },
    },
    user,
  );
  assert.deepEqual(await client.list(0, signal), { items: [row], total: 1 });
  assert.deepEqual(await client.find(id, signal), row);
  assert.equal(calls[0][0], "/api/v1/invoices?offset=0&limit=20");
  assert.equal(calls[0][1], signal);
  await assert.rejects(client.list(-1, signal));
  await assert.rejects(client.find("../bad", signal));
  for (const patch of [
    { role: "SALES_STAFF" },
    { role: "INTERNAL_ADMIN" },
    { mustChangePassword: true },
    { companyId: null },
  ])
    assert.throws(() => new InvoiceClient({}, { ...user, ...patch }));
  const wrong = new InvoiceClient(
    { read: async () => envelope({ ...row, id: orderId }) },
    user,
  );
  await assert.rejects(wrong.find(id, signal));
});
test("document client uses authenticated Portal endpoint, accepts bounded synthetic text and rejects failures", async () => {
  const signal = new AbortController().signal,
    filename = `mock-invoice-${id}.txt`,
    text =
      "SYNTHETIC DEMO INVOICE REFERENCE\nNOT A TAX INVOICE - NO FINANCIAL AUTHORITY\n\n{}\n";
  const headers = {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "content-length": String(Buffer.byteLength(text)),
  };
  const client = new InvoiceClient(
    {
      read: async (path, s) => {
        assert.equal(path, `/api/v1/invoices/${id}/document`);
        assert.equal(s, signal);
        return new Response(text, { headers });
      },
    },
    user,
  );
  assert.deepEqual(await client.download(id, signal), { text, filename });
  for (const response of [
    new Response(text, { status: 503 }),
    new Response(text, {
      headers: { ...headers, "content-disposition": "inline" },
    }),
    new Response("<html>error</html>", { headers }),
    new Response("A".repeat(4097), {
      headers: { ...headers, "content-length": "4097" },
    }),
    new Response(text, { headers: { ...headers, "content-length": "1" } }),
  ]) {
    const bad = new InvoiceClient({ read: async () => response }, user);
    await assert.rejects(bad.download(id, signal));
  }
});
