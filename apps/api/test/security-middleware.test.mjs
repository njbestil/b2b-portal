import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { createApp } from "../dist/app.js";
import { errorHandler, requestIdMiddleware } from "../dist/http.js";
import {
  createRequestGuard,
  securityHeaders,
} from "../dist/security-middleware.js";

async function serve(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("production app applies API security headers to success and error responses", async (t) => {
  const url = await serve(t, createApp({ logger: () => {} }));
  for (const path of ["/", "/missing"]) {
    const response = await fetch(url + path);
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(
      response.headers.get("content-security-policy"),
      /default-src 'none'/,
    );
  }
});

test("guard bounds requests by direct peer, ignores forwarded IPs and recovers after a window", async (t) => {
  let time = 0;
  const app = express();
  app.disable("x-powered-by");
  app.use(
    requestIdMiddleware,
    securityHeaders,
    createRequestGuard(() => time, 2, 1),
  );
  app.get("/", (_request, response) => response.sendStatus(204));
  app.get("/health", (_request, response) => response.sendStatus(204));
  app.use(errorHandler);
  const url = await serve(t, app);
  for (const ip of ["192.0.2.1", "192.0.2.2"]) {
    assert.equal(
      (await fetch(url, { headers: { "X-Forwarded-For": ip } })).status,
      204,
    );
  }
  const limited = await fetch(url, {
    headers: { "X-Forwarded-For": "192.0.2.3" },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(limited.headers.get("cache-control"), "no-store");
  assert.equal(limited.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await limited.json()).error.code, "RATE_LIMITED");
  assert.equal((await fetch(`${url}/health`)).status, 204);
  time = 60000;
  assert.equal((await fetch(url)).status, 204);
});

test("guard bounds its peer table and recovers after expiry", () => {
  let time = 0;
  const guard = createRequestGuard(() => time, 2, 1);
  const invoke = (address) => {
    let error;
    const response = { setHeader() {} };
    guard(
      { method: "GET", path: "/", socket: { remoteAddress: address } },
      response,
      (value) => {
        error = value;
      },
    );
    return error;
  };
  assert.equal(invoke("peer-a"), undefined);
  assert.equal(invoke("peer-b").statusCode, 429);
  time = 60000;
  assert.equal(invoke("peer-b"), undefined);
});

test("fallback JSON parser rejects oversized and compressed request bodies", async (t) => {
  const url = await serve(t, createApp({ logger: () => {} }));
  const large = await fetch(`${url}/missing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: "x".repeat(17000) }),
  });
  assert.equal(large.status, 413);
  assert.equal((await large.json()).error.code, "PAYLOAD_TOO_LARGE");
  const compressed = await fetch(`${url}/missing`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: "{}",
  });
  assert.equal(compressed.status, 415);
});
