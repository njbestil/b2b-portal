import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import {
  EnvironmentConfigurationError,
  parseErpEnvironment,
} from "@b2b-portal/config/server";
import { MockErpAdapter } from "../dist/infrastructure/mock-erp-adapter.js";
import { createErpHealthProbe } from "../dist/services/erp-health.js";
import { createHealthReporter } from "../dist/health.js";
import { createApp } from "../dist/app.js";

const signal = () => new AbortController().signal;
const adapter = (baseUrl, timeoutMs = 1000) =>
  new MockErpAdapter({ baseUrl, timeoutMs });

async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("ERP configuration is optional, normalizes base paths and bounds timeouts", () => {
  for (const value of [undefined, "", " "])
    assert.equal(parseErpEnvironment({ ERP_BASE_URL: value }), undefined);
  for (const protocol of ["http", "https"]) {
    for (const suffix of ["", "/", "///"])
      assert.deepEqual(
        parseErpEnvironment({
          ERP_BASE_URL: `${protocol}://example.test/proxy/mock-erp/v1${suffix}`,
        }),
        {
          baseUrl: `${protocol}://example.test/proxy/mock-erp/v1/`,
          timeoutMs: 1000,
        },
      );
  }
  for (const timeout of ["1", "60000"])
    assert.equal(
      parseErpEnvironment({
        ERP_BASE_URL: "http://example.test",
        ERP_TIMEOUT_MS: timeout,
      }).timeoutMs,
      Number(timeout),
    );
});

test("invalid ERP settings and direct adapter construction reject without reflecting values", () => {
  for (const value of [
    "DO_NOT_LEAK",
    "ftp://DO_NOT_LEAK",
    "http://user:DO_NOT_LEAK@example.test",
    "http://example.test?token=DO_NOT_LEAK",
    "http://example.test/#DO_NOT_LEAK",
    " http://DO_NOT_LEAK",
  ]) {
    assert.throws(
      () => parseErpEnvironment({ ERP_BASE_URL: value }),
      (error) =>
        error instanceof EnvironmentConfigurationError &&
        !error.message.includes("DO_NOT_LEAK"),
    );
    assert.throws(
      () => adapter(value),
      (error) => !error.message.includes("DO_NOT_LEAK"),
    );
  }
  assert.throws(() => adapter(""), TypeError);
  for (const value of [
    "",
    "0",
    "-1",
    "1.5",
    "1e3",
    "60001",
    "Infinity",
    " 20",
    "DO_NOT_LEAK",
  ]) {
    assert.throws(
      () =>
        parseErpEnvironment({
          ERP_BASE_URL: "http://example.test",
          ERP_TIMEOUT_MS: value,
        }),
      (error) =>
        error instanceof EnvironmentConfigurationError &&
        error.message.includes("ERP_TIMEOUT_MS") &&
        !error.message.includes("DO_NOT_LEAK"),
    );
  }
});

test("adapter preserves configured path prefixes and translates wire health to a boolean", async (t) => {
  const calls = [];
  const base = await serve(t, (request, response) => {
    calls.push({
      method: request.method,
      url: request.url,
      accept: request.headers.accept,
    });
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({ status: "up", providerDetails: "DO_NOT_LEAK" }),
    );
  });
  const gateway = adapter(`${base}/proxy/mock-erp/v1`);
  assert.equal(await gateway.checkAvailability(signal()), true);
  assert.deepEqual(calls, [
    {
      method: "GET",
      url: "/proxy/mock-erp/v1/health",
      accept: "application/json",
    },
  ]);
});

test("unsuccessful, malformed, unexpected and oversized responses are unavailable", async (t) => {
  let scenario;
  const base = await serve(t, (_request, response) => {
    response.statusCode = scenario.status ?? 200;
    response.setHeader("Content-Type", scenario.type ?? "application/json");
    response.end(scenario.body);
  });
  const gateway = adapter(base);
  for (scenario of [
    { status: 503, body: "DO_NOT_LEAK_UPSTREAM_ERROR" },
    { status: 404, body: "{}" },
    { status: 204 },
    { type: "text/html", body: '{"status":"up"}' },
    ...[
      "null",
      "[]",
      "true",
      '"up"',
      "{}",
      '{"status":true}',
      '{"status":"down"}',
      '{"status":"UP"}',
      "{invalid DO_NOT_LEAK",
      '{"status":"up","pad":"' + "x".repeat(4096) + '"}',
    ].map((body) => ({ body })),
    { body: Buffer.from([0xff, 0xfe]) },
  ])
    assert.equal(await gateway.checkAvailability(signal()), false);
  scenario = { body: '{"status":"up"}' };
  assert.equal(
    await gateway.checkAvailability(signal()),
    true,
    "a failure must not poison future checks",
  );
});

test("adapter accepts the 4096-byte limit but rejects a larger payload", async (t) => {
  const envelope = JSON.stringify({ status: "up", pad: "" });
  let size = 4096;
  const base = await serve(t, (_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        status: "up",
        pad: "x".repeat(size - Buffer.byteLength(envelope)),
      }),
    );
  });
  const gateway = adapter(base);
  assert.equal(await gateway.checkAvailability(signal()), true);
  size++;
  assert.equal(await gateway.checkAvailability(signal()), false);
});

test("redirects are not followed", async (t) => {
  let redirectedCalls = 0;
  const destination = await serve(t, (_request, response) => {
    redirectedCalls++;
    response.end('{"status":"up"}');
  });
  const base = await serve(t, (_request, response) => {
    response.writeHead(302, { location: destination });
    response.end();
  });
  assert.equal(await adapter(base).checkAvailability(signal()), false);
  assert.equal(redirectedCalls, 0);
});

for (const headersSent of [false, true]) {
  test(
    `deadline aborts stalled ${headersSent ? "body" : "headers"} and closes the request`,
    { timeout: 3000 },
    async (t) => {
      let disconnected;
      const closed = new Promise((resolve) => (disconnected = resolve));
      const base = await serve(t, (_request, response) => {
        response.once("close", disconnected);
        if (headersSent) {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"status":');
        }
      });
      assert.equal(await adapter(base, 100).checkAvailability(signal()), false);
      await closed;
    },
  );
}

test(
  "caller cancellation aborts in-flight I/O and pre-aborted calls do no I/O",
  { timeout: 3000 },
  async (t) => {
    let requestStarted;
    let requestClosed;
    let calls = 0;
    const started = new Promise((resolve) => (requestStarted = resolve));
    const closed = new Promise((resolve) => (requestClosed = resolve));
    const base = await serve(t, (_request, response) => {
      calls++;
      response.once("close", requestClosed);
      requestStarted();
    });
    const gateway = adapter(base);
    const controller = new AbortController();
    const checking = gateway.checkAvailability(controller.signal);
    await started;
    controller.abort();
    assert.equal(await checking, false);
    await closed;
    assert.equal(await gateway.checkAvailability(controller.signal), false);
    assert.equal(calls, 1);
  },
);

test("neutral service accepts a substitute gateway and forwards cancellation", async () => {
  const signals = [];
  const probe = createErpHealthProbe({
    async checkAvailability(value) {
      signals.push(value);
      return true;
    },
  });
  const abortSignal = signal();
  assert.equal(await probe(abortSignal), true);
  assert.deepEqual(signals, [abortSignal]);
});

test("API health uses the gateway and never reflects upstream payloads", async (t) => {
  let valid = true;
  const base = await serve(t, (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(valid ? '{"status":"up"}' : '{"status":"DO_NOT_LEAK"}');
  });
  const records = [];
  const app = createApp({
    logger: (_level, event) => records.push(event),
    healthChecks: {
      storage: async () => true,
      erp: createErpHealthProbe(adapter(base)),
    },
  });
  const api = await serve(t, app);
  for (valid of [true, false, true]) {
    const response = await fetch(`${api}/health`);
    const body = await response.json();
    assert.equal(response.status, valid ? 200 : 503);
    const report = valid ? body.data : body.error.details;
    assert.equal(report.erp.status, valid ? "up" : "down");
    assert.ok(!JSON.stringify({ body, records }).includes("DO_NOT_LEAK"));
  }
  const report = await createHealthReporter({
    erp: createErpHealthProbe(adapter(base)),
  })();
  assert.equal(report.storage.status, "unconfigured");
});

const isolatedEnv = (settings) => ({
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  NODE_ENV: "test",
  ...settings,
});
const apiEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("actual API entry point rejects malformed ERP settings safely", () => {
  for (const settings of [
    { ERP_BASE_URL: "http://user:DO_NOT_LEAK@example.test" },
    { ERP_BASE_URL: "http://example.test", ERP_TIMEOUT_MS: "DO_NOT_LEAK" },
  ]) {
    const child = spawnSync(process.execPath, [apiEntry], {
      env: isolatedEnv({
        API_HOST: "127.0.0.1",
        API_PORT: "3000",
        ...settings,
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.equal(JSON.parse(child.stderr).reason, "invalid_environment");
    assert.ok(!child.stderr.includes("DO_NOT_LEAK"));
  }
});

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function launch(t, entry, settings) {
  const child = spawn(process.execPath, [entry], {
    env: isolatedEnv(settings),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const closed = once(child, "close");
  t.after(async () => {
    child.kill();
    await closed;
  });
  return { child, closed, output: () => output };
}

async function waitForHttp(url, process) {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(process.child.exitCode, null, process.output());
    try {
      return await fetch(url, { signal: AbortSignal.timeout(1500) });
    } catch {
      await delay(25);
    }
  }
  assert.fail("Service did not start");
}

test(
  "real Mock ERP and API processes communicate through the configured adapter",
  { timeout: 10000 },
  async (t) => {
    const mockPort = await availablePort();
    const mockEntry = fileURLToPath(
      new URL("../../mock-erp/dist/index.js", import.meta.url),
    );
    const mock = launch(t, mockEntry, {
      MOCK_ERP_HOST: "127.0.0.1",
      MOCK_ERP_PORT: String(mockPort),
    });
    assert.deepEqual(
      await (
        await waitForHttp(
          `http://127.0.0.1:${mockPort}/mock-erp/v1/health`,
          mock,
        )
      ).json(),
      { status: "up" },
    );
    const apiPort = await availablePort();
    const api = launch(t, apiEntry, {
      API_HOST: "127.0.0.1",
      API_PORT: String(apiPort),
      ERP_BASE_URL: `http://127.0.0.1:${mockPort}/mock-erp/v1`,
    });
    const healthy = await waitForHttp(
      `http://127.0.0.1:${apiPort}/health`,
      api,
    );
    assert.equal(healthy.status, 503, "storage is intentionally unconfigured");
    const report = (await healthy.json()).error.details;
    assert.equal(report.erp.status, "up");
    assert.equal(report.storage.status, "unconfigured");
    mock.child.kill();
    await mock.closed;
    const down = await fetch(`http://127.0.0.1:${apiPort}/health`);
    assert.equal((await down.json()).error.details.erp.status, "down");
  },
);

test("TypeScript gateway contract accepts alternatives and rejects HTTP payload coupling", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const path = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  const config = ts.readConfigFile(path, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    root,
    { noEmit: true, rootDir: root },
    path,
  );
  assert.deepEqual(parsed.errors, []);
  const program = ts.createProgram(
    [
      ...parsed.fileNames,
      fileURLToPath(new URL("./fixtures/erp-gateway.ts", import.meta.url)),
    ],
    parsed.options,
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getCanonicalFileName: (name) => name,
      getNewLine: () => "\n",
    }),
  );
});
