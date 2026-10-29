import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { createApp } from "../dist/app.js";
import {
  errorHandler,
  HttpError,
  notFoundHandler,
  requestIdMiddleware,
  sendSuccess,
} from "../dist/http.js";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

async function readEnvelope(response) {
  assert.match(response.headers.get("content-type"), /^application\/json/);
  const body = await response.json();
  assert.match(body.requestId, uuid);
  assert.equal(body.requestId, response.headers.get("x-request-id"));
  return body;
}

function assertFailure(body, code, message) {
  assert.deepEqual(body, {
    success: false,
    error: { code, message },
    requestId: body.requestId,
  });
}

// Failure routes exist only in this test harness, never in the production app.
function errorApp(mode) {
  const app = express();
  app.set("env", mode);
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.post("/created", (request, response) =>
    sendSuccess(response, request.body, 201),
  );
  app.get("/expected", () => {
    throw new HttpError(409, "CONFLICT", "The resource was changed.");
  });
  app.get("/unavailable", () => {
    throw new HttpError(503, "SERVICE_UNAVAILABLE", "Temporarily unavailable.");
  });
  app.get("/sync", () => {
    throw new Error("DO_NOT_LEAK_SYNC_ERROR");
  });
  app.get("/async", async () => {
    throw new Error("DO_NOT_LEAK_ASYNC_ERROR");
  });
  app.get("/non-error", () => {
    throw { password: "DO_NOT_LEAK_OBJECT" };
  });
  app.get("/client-error", () => {
    throw Object.assign(new Error("DO_NOT_LEAK_CLIENT_ERROR"), { status: 400 });
  });
  app.get("/bad-status", () => {
    throw Object.assign(new Error("DO_NOT_LEAK_BAD_STATUS"), { status: 700 });
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

test("the production app returns a standard success envelope and a matching request-ID header", async (t) => {
  const base = await serve(t, createApp({ logger: () => {} }));
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  const body = await readEnvelope(response);
  assert.deepEqual(body, {
    success: true,
    data: { service: "b2b-portal-api" },
    requestId: body.requestId,
  });
});

test("unmatched paths and methods return JSON 404s without reflecting input", async (t) => {
  const base = await serve(t, createApp({ logger: () => {} }));
  for (const [path, method] of [
    ["/missing?secret=DO_NOT_ECHO", "GET"],
    ["/", "DELETE"],
  ]) {
    const response = await fetch(`${base}${path}`, { method });
    assert.equal(response.status, 404);
    assertFailure(
      await readEnvelope(response),
      "NOT_FOUND",
      "Route not found.",
    );
  }
});

test("request IDs are server-generated, distinct across concurrent requests, and independent of client headers", async (t) => {
  const base = await serve(t, createApp({ logger: () => {} }));
  const supplied = "00000000-0000-4000-8000-000000000000";
  const bodies = await Promise.all(
    Array.from({ length: 10 }, async () => {
      const response = await fetch(`${base}/`, {
        headers: { "x-request-id": supplied },
      });
      const body = await readEnvelope(response);
      assert.notEqual(body.requestId, supplied);
      return body;
    }),
  );
  assert.equal(new Set(bodies.map((body) => body.requestId)).size, 10);
});

test("HEAD responses preserve HTTP semantics and carry the request ID in their header", async (t) => {
  const base = await serve(t, createApp({ logger: () => {} }));
  const response = await fetch(`${base}/`, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-request-id"), uuid);
  assert.equal(await response.text(), "");
});

test("JSON parser failures use safe standard envelopes and request IDs", async (t) => {
  const base = await serve(t, createApp({ logger: () => {} }));
  const cases = [
    {
      body: '{"secret":"DO_NOT_ECHO"',
      headers: { "content-type": "application/json" },
      status: 400,
      code: "INVALID_JSON",
      message: "Malformed JSON request body.",
    },
    {
      body: JSON.stringify({ text: "x".repeat(110 * 1024) }),
      headers: { "content-type": "application/json" },
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body is too large.",
    },
    {
      body: "{}",
      headers: { "content-type": "application/json; charset=iso-8859-1" },
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "Unsupported request body encoding.",
    },
    {
      body: "{}",
      headers: {
        "content-type": "application/json",
        "content-encoding": "unsupported",
      },
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "Unsupported request body encoding.",
    },
    {
      body: "not-gzip",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      status: 400,
      code: "REQUEST_ERROR",
      message: "The request could not be processed.",
    },
  ];
  for (const scenario of cases) {
    const response = await fetch(`${base}/`, {
      method: "POST",
      headers: scenario.headers,
      body: scenario.body,
    });
    assert.equal(response.status, scenario.status);
    assertFailure(
      await readEnvelope(response),
      scenario.code,
      scenario.message,
    );
  }
});

for (const mode of ["development", "production"]) {
  test(`${mode}: explicit HTTP errors preserve their public code, message, and status`, async (t) => {
    const base = await serve(t, errorApp(mode));
    for (const [path, status, code, message] of [
      ["/expected", 409, "CONFLICT", "The resource was changed."],
      ["/unavailable", 503, "SERVICE_UNAVAILABLE", "Temporarily unavailable."],
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, status);
      assertFailure(await readEnvelope(response), code, message);
    }
  });

  test(`${mode}: synchronous, asynchronous, and non-Error failures do not leak internal details`, async (t) => {
    const base = await serve(t, errorApp(mode));
    for (const path of ["/sync", "/async", "/non-error", "/bad-status"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 500);
      assertFailure(
        await readEnvelope(response),
        "INTERNAL_SERVER_ERROR",
        "Internal server error.",
      );
    }
  });
}

test("unrecognized client errors retain a valid 4xx status without exposing messages", async (t) => {
  const base = await serve(t, errorApp("test"));
  const response = await fetch(`${base}/client-error`);
  assert.equal(response.status, 400);
  assertFailure(
    await readEnvelope(response),
    "REQUEST_ERROR",
    "The request could not be processed.",
  );
});

test("the success helper preserves a route's JSON payload and explicit 201 status", async (t) => {
  const base = await serve(t, errorApp("test"));
  const data = { name: "Example", items: [1, 2], optional: null };
  const response = await fetch(`${base}/created`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  assert.equal(response.status, 201);
  const body = await readEnvelope(response);
  assert.deepEqual(body, { success: true, data, requestId: body.requestId });
});

test("errors after headers are sent delegate to Express without attempting another response", () => {
  const original = new Error("stream failed");
  let delegated;
  errorHandler(original, {}, { headersSent: true }, (error) => {
    delegated = error;
  });
  assert.equal(delegated, original);
});

test("invalid declared HTTP statuses are rejected", () => {
  for (const status of [200, 399, 600, 400.5, NaN]) {
    assert.throws(
      () => new HttpError(status, "BAD_STATUS", "Public message"),
      RangeError,
    );
  }
});
