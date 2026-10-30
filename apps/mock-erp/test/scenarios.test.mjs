import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { parseScenario, runScenario } from "../dist/scenarios.js";

const body = () => ({
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
function post(url, key, value, scenario, signal = AbortSignal.timeout(5000)) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...(scenario === undefined ? {} : { "X-Mock-ERP-Scenario": scenario }),
    },
    body: JSON.stringify(value),
    signal,
  });
}
const failures = [
  ["unavailable", 503, "ERP_UNAVAILABLE"],
  ["validation", 422, "ERP_VALIDATION_FAILED"],
  ["credit-hold", 422, "CREDIT_HOLD"],
  ["insufficient-stock", 409, "INSUFFICIENT_STOCK"],
];

test("only exact allowlisted scenario names are accepted without reflecting input", () => {
  assert.equal(parseScenario(undefined), "success");
  for (const value of [
    "",
    "SUCCESS",
    " timeout",
    "timeout,success",
    "DO_NOT_LEAK",
  ])
    assert.throws(
      () => parseScenario(value),
      (error) =>
        error.code === "INVALID_SCENARIO" &&
        !error.message.includes("DO_NOT_LEAK"),
    );
});
test("all synthetic business/503 outcomes are reproducible and do not reserve ledger identities", async (t) => {
  const url = await serve(t);
  for (const [scenario, status, code] of failures) {
    const value = body(),
      key = randomUUID();
    for (let i = 0; i < 2; i++) {
      const response = await post(url, key, value, scenario);
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.code, code);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    const recovered = await post(url, key, value, "success");
    assert.equal(recovered.status, 201);
    const expected = await recovered.json();
    for (const later of [
      undefined,
      ...failures.map((row) => row[0]),
      "timeout",
    ]) {
      const replay = await post(url, key, value, later);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), expected);
    }
    const conflict = await post(
      url,
      key,
      { ...value, customerId: "DEMO-C002" },
      "unavailable",
    );
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
    const duplicate = await post(url, randomUUID(), value, "success");
    assert.equal((await duplicate.json()).error.code, "ORDER_ALREADY_EXISTS");
  }
});
test("request validation precedes failure injection and unknown controls stay redacted", async (t) => {
  const url = await serve(t);
  for (const scenario of ["timeout", ...failures.map((row) => row[0])]) {
    const response = await post(
      url,
      "valid-key",
      { ...body(), customerId: "DO_NOT_LEAK" },
      scenario,
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_ORDER");
  }
  const response = await post(url, "valid-key", body(), "DO_NOT_LEAK");
  assert.equal(response.status, 400);
  assert.ok(!(await response.text()).includes("DO_NOT_LEAK"));
});
test("timeout is bounded, cancellable and leaves no order to duplicate on recovery", async (t) => {
  const url = await serve(t),
    value = body(),
    key = randomUUID();
  await assert.rejects(
    post(url, key, value, "timeout", AbortSignal.timeout(50)),
  );
  const recovered = await post(url, key, value, "success");
  assert.equal(recovered.status, 201);
  const expected = await recovered.json();
  const delayed = await post(url, "another-timeout", body(), "timeout");
  assert.equal(delayed.status, 504);
  assert.equal((await delayed.json()).error.code, "ERP_TIMEOUT");
  const replay = await post(url, key, value, "timeout");
  assert.deepEqual(await replay.json(), expected);
  const controller = new AbortController();
  const pending = runScenario("timeout", controller.signal, 60000);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
test("concurrent recoveries create exactly one retained order after a temporary failure", async (t) => {
  const url = await serve(t),
    value = body(),
    key = randomUUID();
  assert.equal((await post(url, key, value, "unavailable")).status, 503);
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => post(url, key, value, "success")),
  );
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(responses.filter((r) => r.status === 200).length, 11);
  const rows = await Promise.all(responses.map((r) => r.json()));
  assert.ok(rows.every((row) => row.erpOrderId === rows[0].erpOrderId));
});
test("actual Mock ERP process exposes failure scenarios and success recovery", async (t) => {
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    {
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        NODE_ENV: "test",
        MOCK_ERP_HOST: "127.0.0.1",
        MOCK_ERP_PORT: String(port),
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await closed;
  });
  const url = `http://127.0.0.1:${port}/mock-erp/v1/orders`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/mock-erp/v1/health`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      // Listener may not be ready yet; the bounded loop owns startup waiting.
    }
    await delay(20);
  }
  assert.ok(ready);
  const value = body(),
    key = randomUUID();
  assert.equal((await post(url, key, value, "credit-hold")).status, 422);
  assert.equal((await post(url, key, value, "unavailable")).status, 503);
  assert.equal((await post(url, key, value)).status, 201);
  assert.equal((await post(url, key, value)).status, 200);
});
