import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import express from "express";
import { createApp } from "../dist/app.js";
import { createHealthReporter } from "../dist/health.js";
import { errorHandler, requestIdMiddleware } from "../dist/http.js";
import { createLogger, requestLogging } from "../dist/logging.js";

function capture() {
  const records = [];
  const logger = createLogger((line, level) => {
    assert.equal(line.split("\n").length, 1);
    const record = JSON.parse(line);
    assert.equal(record.level, level);
    assert.equal(record.service, "b2b-portal-api");
    assert.equal(new Date(record.timestamp).toISOString(), record.timestamp);
    records.push(record);
  });
  return { records, logger };
}

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
  return { base: `http://127.0.0.1:${server.address().port}`, server };
}

async function health(base) {
  const response = await fetch(`${base}/health`, {
    signal: AbortSignal.timeout(2000),
  });
  const body = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-request-id"), body.requestId);
  assert.equal(body.success, response.status === 200);
  if (!body.success) {
    assert.equal(body.error.code, "SERVICE_NOT_READY");
    assert.equal(body.error.message, "Required dependencies are not ready.");
  }
  return {
    response,
    body,
    report: body.success ? body.data : body.error.details,
  };
}

test("default health reports API up and dependencies unconfigured, never falsely ready", async (t) => {
  const { records, logger } = capture();
  const { base } = await serve(t, createApp({ logger }));
  const { response, body, report } = await health(base);
  assert.equal(response.status, 503);
  assert.deepEqual(report, {
    status: "degraded",
    api: { status: "up" },
    storage: { status: "unconfigured" },
    erp: { status: "unconfigured" },
  });
  const checked = records.find((entry) => entry.event === "health.checked");
  assert.equal(checked.requestId, body.requestId);
  assert.equal(checked.level, "warn");
  assert.deepEqual(checked.health, report);
  const completed = records.filter(
    (entry) => entry.event === "request.completed",
  );
  assert.equal(completed.length, 1);
  assert.equal(completed[0].requestId, body.requestId);
  assert.equal(completed[0].statusCode, 503);
  assert.equal(completed[0].level, "error");
});

test("healthy probes return 200, failures return 503, and recovery is checked afresh", async (t) => {
  const { records, logger } = capture();
  let storageUp = true;
  let calls = 0;
  const { base } = await serve(
    t,
    createApp({
      logger,
      healthChecks: {
        storage: async (signal) => {
          assert.ok(signal instanceof AbortSignal);
          calls++;
          return storageUp;
        },
        erp: async () => true,
      },
    }),
  );
  for (const ready of [true, false, true]) {
    storageUp = ready;
    const { response, report } = await health(base);
    assert.equal(response.status, ready ? 200 : 503);
    assert.deepEqual(report, {
      status: ready ? "up" : "degraded",
      api: { status: "up" },
      storage: { status: ready ? "up" : "down" },
      erp: { status: "up" },
    });
  }
  assert.equal(calls, 3);
  assert.deepEqual(
    records
      .filter((entry) => entry.event === "health.checked")
      .map((entry) => entry.level),
    ["info", "warn", "info"],
  );
});

for (const dependency of ["storage", "erp"]) {
  test(`${dependency} false/throw/rejection/invalid results are safe down states`, async (t) => {
    const { records, logger } = capture();
    const failures = [
      () => false,
      () => {
        throw new Error("DO_NOT_LEAK_SYNC_PASSWORD");
      },
      async () => {
        throw { connection: "DO_NOT_LEAK_CONNECTION_STRING" };
      },
      async () => ({ password: "DO_NOT_LEAK_PROVIDER_PAYLOAD" }),
    ];
    let probe;
    const { base } = await serve(
      t,
      createApp({
        logger,
        healthChecks: {
          storage: async () => true,
          erp: async () => true,
          [dependency]: (signal) => probe(signal),
        },
      }),
    );
    for (probe of failures) {
      const { response, body, report } = await health(base);
      assert.equal(response.status, 503);
      assert.equal(report[dependency].status, "down");
      assert.equal(
        report[dependency === "erp" ? "storage" : "erp"].status,
        "up",
      );
      assert.ok(!JSON.stringify({ body, records }).includes("DO_NOT_LEAK"));
    }
  });
}

test("probes run concurrently, time out even when ignoring abort, and contain late rejections", async () => {
  let rejectLate;
  const signals = [];
  const reporter = createHealthReporter(
    {
      storage: (signal) => {
        signals.push(signal);
        return new Promise((_, reject) => {
          rejectLate = reject;
        });
      },
      erp: (signal) => {
        // Storage must already be running, not awaited before ERP starts.
        assert.equal(signals.length, 1);
        signals.push(signal);
        return new Promise(() => {});
      },
    },
    20,
  );
  const report = await reporter();
  assert.equal(report.storage.status, "timeout");
  assert.equal(report.erp.status, "timeout");
  assert.equal(report.status, "degraded");
  assert.ok(signals.every((signal) => signal.aborted));
  rejectLate(new Error("DO_NOT_LEAK_LATE_FAILURE"));
  await setTimeout(0);
});

test("the HTTP health route also bounds a hanging dependency", async (t) => {
  const { logger } = capture();
  const { base } = await serve(
    t,
    createApp({
      logger,
      healthTimeoutMs: 20,
      healthChecks: {
        storage: async () => true,
        erp: () => new Promise(() => {}),
      },
    }),
  );
  const { response, report } = await health(base);
  assert.equal(response.status, 503);
  assert.equal(report.storage.status, "up");
  assert.equal(report.erp.status, "timeout");
});

test("invalid health timeout settings fail immediately", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 60_001]) {
    assert.throws(() => createHealthReporter({}, value), RangeError);
  }
});

test("health HEAD keeps status and request correlation without a body", async (t) => {
  const { logger } = capture();
  const { base } = await serve(t, createApp({ logger }));
  const response = await fetch(`${base}/health`, { method: "HEAD" });
  assert.equal(response.status, 503);
  assert.ok(response.headers.get("x-request-id"));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
});

test("request logs correlate concurrent successes and parser/404 failures without sensitive input", async (t) => {
  const { records, logger } = capture();
  const { base } = await serve(t, createApp({ logger }));
  const scenarios = [
    ["/", { headers: { authorization: "DO_NOT_LEAK_AUTHORIZATION" } }, 200],
    ["/DO_NOT_LEAK_PATH?token=DO_NOT_LEAK_QUERY", {}, 404],
    [
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "DO_NOT_LEAK_COOKIE",
          "x-request-id": "DO_NOT_LEAK_CLIENT_ID",
        },
        body: '{"password":"DO_NOT_LEAK_BODY"',
      },
      400,
    ],
  ];
  const bodies = await Promise.all(
    scenarios.map(async ([path, options, status]) => {
      const response = await fetch(`${base}${path}`, options);
      assert.equal(response.status, status);
      return response.json();
    }),
  );
  assert.equal(records.length, 3);
  for (const [index, body] of bodies.entries()) {
    const entries = records.filter(
      (entry) => entry.requestId === body.requestId,
    );
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.statusCode, scenarios[index][2]);
    assert.equal(entry.level, entry.statusCode >= 400 ? "warn" : "info");
    assert.equal(entry.outcome, "completed");
    assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs >= 0);
    assert.deepEqual(Object.keys(entry).sort(), [
      "durationMs",
      "event",
      "level",
      "method",
      "outcome",
      "requestId",
      "service",
      "statusCode",
      "timestamp",
    ]);
  }
  assert.ok(!JSON.stringify(records).includes("DO_NOT_LEAK"));
  assert.equal(new Set(records.map((entry) => entry.requestId)).size, 3);
});

test("unexpected failures are error-level logs, with no exception messages or stacks", async (t) => {
  const { records, logger } = capture();
  const app = express();
  app.use(requestIdMiddleware);
  app.use(requestLogging(logger));
  app.get("/", async () => {
    throw new Error("DO_NOT_LEAK_INTERNAL_ERROR");
  });
  app.use(errorHandler);
  const { base } = await serve(t, app);
  const response = await fetch(base);
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(records.length, 1);
  assert.equal(records[0].level, "error");
  assert.equal(records[0].requestId, body.requestId);
  assert.ok(!JSON.stringify({ body, records }).includes("DO_NOT_LEAK"));
});

test("aborted responses log once without pretending an HTTP response completed", () => {
  const { records, logger } = capture();
  const response = Object.assign(new EventEmitter(), {
    locals: { requestId: "server-request-id" },
    statusCode: 200,
  });
  let nextCalled = false;
  requestLogging(logger)(
    { method: "DO_NOT_LEAK_CUSTOM_METHOD" },
    response,
    () => {
      nextCalled = true;
    },
  );
  response.emit("close");
  response.emit("finish");
  assert.ok(nextCalled);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "aborted");
  assert.equal(records[0].level, "warn");
  assert.equal(records[0].method, "OTHER");
  assert.ok(!("statusCode" in records[0]));
  assert.ok(!JSON.stringify(records).includes("DO_NOT_LEAK"));
});

function isolatedEnvironment(port) {
  return {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
  };
}

const entryPoint = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("actual entry point emits structured redacted configuration errors", () => {
  const child = spawnSync(process.execPath, [entryPoint], {
    env: isolatedEnvironment("DO_NOT_LEAK_INVALID_PORT"),
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  const record = JSON.parse(child.stderr);
  assert.equal(record.event, "api.start_failed");
  assert.equal(record.reason, "invalid_environment");
  assert.equal(record.level, "error");
  assert.match(record.diagnostic, /API_PORT/);
  assert.ok(!child.stderr.includes("DO_NOT_LEAK"));
});

test("actual entry point logs listen failures safely instead of raw network errors", async (t) => {
  const { logger } = capture();
  const { server } = await serve(t, createApp({ logger }));
  const child = spawn(process.execPath, [entryPoint], {
    env: isolatedEnvironment(server.address().port),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const closed = once(child, "close");
  t.after(() => child.kill());
  const [code] = await closed;
  assert.equal(code, 1);
  assert.equal(stdout, "");
  const record = JSON.parse(stderr);
  assert.equal(record.event, "api.start_failed");
  assert.equal(record.reason, "listen_failed");
  assert.equal(record.level, "error");
  assert.ok(!stderr.includes("127.0.0.1"));
  assert.ok(!stderr.includes("stack"));
});
