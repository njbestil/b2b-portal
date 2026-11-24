import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
let vite, Client, view, message, reason, State;
const id = "12345678-1234-4234-8234-123456789abc",
  order = "22345678-1234-4234-8234-123456789abc",
  key = "32345678-1234-4234-8234-123456789abc";
const user = {
  id,
  companyId: id,
  role: "CUSTOMER_ADMIN",
  mustChangePassword: false,
  displayName: "Synthetic buyer",
};
before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  ({
    CancellationClient: Client,
    cancellationView: view,
    cancellationMessage: message,
    cancellationReason: reason,
  } = await vite.ssrLoadModule("/src/features/cancellations/api.ts"));
  ({ CancellationState: State } = await vite.ssrLoadModule(
    "/src/features/cancellations/CancellationPage.tsx",
  ));
});
after(async () => vite?.close());
const signal = () => new AbortController().signal;
const result = (status) => ({
  requestId: key,
  orderId: order,
  status,
  reason: "PRIVATE_REASON",
  providerError: "PRIVATE_ERROR",
});
const response = (data, status = 200) =>
  new Response(JSON.stringify({ success: true, requestId: key, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
test("requested, approved and rejected states are distinct canonical customer messages without technical/private content", () => {
  for (const [status, title] of [
    ["PENDING", "Cancellation requested"],
    ["APPROVED", "Cancellation approved"],
    ["REJECTED", "Cancellation rejected"],
  ]) {
    const value = view(result(status), order);
    assert.deepEqual(
      Object.keys(value).sort(),
      ["requestId", "orderId", "status"].sort(),
    );
    assert.equal(message(status).title, title);
    const html = renderToStaticMarkup(createElement(State, { value }));
    assert.ok(html.includes(title));
    assert.ok(!/PRIVATE|PENDING|APPROVED|REJECTED/.test(html));
  }
  assert.equal(view(null, order), null);
  assert.throws(() => view({ ...result("PENDING"), orderId: id }, order), {
    code: "unavailable",
  });
  assert.throws(() => view(result("UNKNOWN"), order), { code: "unavailable" });
});
test("reasons are trimmed, bounded, required and reject controls and broken Unicode", () => {
  assert.equal(reason("  Changed plans  "), "Changed plans");
  for (const value of [
    "",
    " ",
    "x".repeat(501),
    "bad\u0000reason",
    "bad\u0085reason",
    "\ud800",
  ])
    assert.throws(() => reason(value), { code: "invalid" });
});
test("client forwards one stable idempotency key, exact reason and cancellation identity without automatic retries", async () => {
  const calls = [],
    client = new Client(
      {
        async request(path, init) {
          calls.push({ path, init });
          return response(result("PENDING"), 202);
        },
      },
      user,
    );
  const s = signal();
  const r = await client.submit(order, " Change of plans ", key, s);
  assert.equal(r.cancellation.status, "PENDING");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].path,
    `/api/v1/companies/${id}/orders/${order}/cancellations`,
  );
  assert.equal(calls[0].init.idempotencyKey, key);
  assert.equal(calls[0].init.signal, s);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    reason: "Change of plans",
  });
  let attempts = 0;
  const unavailable = new Client(
    {
      async request() {
        attempts++;
        throw new Error("PRIVATE");
      },
    },
    user,
  );
  await assert.rejects(
    unavailable.submit(order, "reason", key, signal()),
    (e) => e.code === "unavailable" && !e.message.includes("PRIVATE"),
  );
  assert.equal(attempts, 1);
});
test("foreign/malformed reads and ineligible identities cannot become valid cancellation data", async () => {
  for (const patch of [
    { role: "SALES_STAFF" },
    { role: "INTERNAL_ADMIN" },
    { mustChangePassword: true },
    { companyId: null },
  ])
    await assert.rejects(
      new Client(
        {
          request() {
            assert.fail("must not read");
          },
        },
        { ...user, ...patch },
      ).latest(order, signal()),
      { code: "forbidden" },
    );
  const foreign = new Client(
    {
      async request() {
        return response({
          cancellation: { ...result("PENDING"), orderId: id },
        });
      },
    },
    user,
  );
  await assert.rejects(foreign.latest(order, signal()), {
    code: "unavailable",
  });
  const html = new Client(
    {
      async request() {
        return new Response("<html>PRIVATE</html>", {
          headers: { "content-type": "text/html" },
        });
      },
    },
    user,
  );
  await assert.rejects(html.latest(order, signal()), { code: "unavailable" });
});
