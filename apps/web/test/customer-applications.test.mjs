import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  submitApplication,
  ApplicationSubmissionError,
} from "../src/features/customer-applications/api.ts";
const reference = "12345678-1234-4234-8234-123456789abc";
const input = {
  companyName: "Synthetic",
  tradeLicenseReference: "DEMO",
  businessEmail: "business@example.test",
  phone: "555",
  billingAddress: "Synthetic billing",
  deliveryAddress: "Synthetic delivery",
  administratorName: "Synthetic Admin",
  administratorEmail: "admin@example.test",
  administratorMobile: "556",
  password: "synthetic temporary password",
};
const accepted = () =>
  new Response(
    JSON.stringify({
      success: true,
      requestId: reference,
      data: { state: "received", reference },
    }),
    { status: 202, headers: { "content-type": "application/json" } },
  );
test("application boundary sends only the intake contract and accepts an anonymous validated receipt", async () => {
  let call;
  assert.equal(
    await submitApplication(input, undefined, async (url, options) => {
      call = { url, options };
      return accepted();
    }),
    reference,
  );
  assert.equal(call.url, "/api/v1/customer-applications");
  assert.equal(call.options.method, "POST");
  assert.deepEqual(JSON.parse(call.options.body), input);
  assert.equal(call.options.credentials, "omit");
  assert.equal(call.options.headers.Authorization, undefined);
  assert.equal(
    await submitApplication(input, undefined, async () => accepted()),
    reference,
  );
});
test("application errors, malformed envelopes and network failures never become success or raw messages", async () => {
  for (const [status, code] of [
    [400, "invalid"],
    [413, "size"],
    [415, "media"],
    [429, "rate"],
    [503, "unavailable"],
    [200, "unavailable"],
  ])
    await assert.rejects(
      submitApplication(
        input,
        undefined,
        async () =>
          new Response("DO_NOT_RENDER", {
            status,
            headers: { "retry-after": "60" },
          }),
      ),
      (e) =>
        e instanceof ApplicationSubmissionError &&
        e.code === code &&
        !e.message.includes("DO_NOT_RENDER"),
    );
  for (const body of [
    { success: false },
    {
      success: true,
      requestId: reference,
      data: { state: "approved", reference },
    },
    {
      success: true,
      requestId: "mismatch",
      data: { state: "received", reference },
    },
  ])
    await assert.rejects(
      submitApplication(
        input,
        undefined,
        async () =>
          new Response(JSON.stringify(body), {
            status: 202,
            headers: { "content-type": "application/json" },
          }),
      ),
      { code: "unavailable" },
    );
  await assert.rejects(
    submitApplication(
      input,
      undefined,
      async () =>
        new Response("<html>SPA fallback</html>", {
          status: 202,
          headers: { "content-type": "text/html" },
        }),
    ),
    { code: "unavailable" },
  );
  await assert.rejects(
    submitApplication(input, undefined, async () => {
      throw Error("DO_NOT_RENDER");
    }),
    { code: "unavailable" },
  );
  for (const value of ["-1", "9999999999", "bad"])
    await assert.rejects(
      submitApplication(
        input,
        undefined,
        async () =>
          new Response("", { status: 429, headers: { "retry-after": value } }),
      ),
      (e) => e.code === "rate" && e.retryAfter === undefined,
    );
});
let server, App;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  ({ App } = await server.ssrLoadModule("/src/app.tsx"));
});
after(async () => server?.close());
const render = (entry) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      createElement(App),
    ),
  );
test("actual application route has native grouped inputs, associated labels and an always-operable submit", () => {
  const html = render("/apply");
  assert.equal((html.match(/<main[\s>]/g) ?? []).length, 1);
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.equal((html.match(/<input[\s>]/g) ?? []).length, 10);
  assert.equal((html.match(/<fieldset[\s>]/g) ?? []).length, 2);
  for (const key of Object.keys(input))
    assert.ok(html.includes(`name="${key}"`));
  const ids = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  for (const id of ids) assert.ok(html.includes(`for="${id}"`));
  assert.match(html, /<button[^>]*type="submit"/);
  assert.ok(!html.includes('disabled=""'));
  assert.match(html, /role="status"/);
  assert.match(html, /autocomplete="section-administrator new-password"/i);
  assert.ok(!html.includes("Explore workspace preview"));
});
test("actual receipt route renders only receipt/review guidance and no fake account or service promise", () => {
  const html = render({ pathname: "/apply/received", state: { reference } });
  assert.equal((html.match(/<main[\s>]/g) ?? []).length, 1);
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.ok(html.includes(reference));
  assert.ok(html.includes("Receipt reference"));
  assert.ok(!html.includes("GPC-APP-2048"));
  assert.ok(!html.includes("2 business days"));
  assert.ok(!html.includes("<input"));
  assert.match(html, /href="\/login"/);
});
