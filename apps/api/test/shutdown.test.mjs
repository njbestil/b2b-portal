import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createShutdown } from "../dist/shutdown.js";

function captured() {
  const records = [];
  return {
    records,
    logger: (level, event) => records.push({ level, ...event }),
  };
}

test("shutdown stops new HTTP work, drains in-flight work, then closes storage once", async (t) => {
  let finish;
  let requestStarted;
  const started = new Promise((resolve) => (requestStarted = resolve));
  const server = createServer((_request, response) => {
    finish = () => response.end("done");
    requestStarted();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const active = fetch(base, { headers: { connection: "close" } });
  await started;
  const { records, logger } = captured();
  let storageCloses = 0;
  const shutdown = createShutdown(
    server,
    async () => {
      storageCloses++;
    },
    logger,
  );
  const stopping = shutdown("SIGTERM");
  assert.equal(shutdown("SIGINT"), stopping);
  assert.equal(storageCloses, 0);
  assert.equal(server.listening, false);
  await assert.rejects(fetch(base));
  finish();
  assert.equal(await (await active).text(), "done");
  assert.equal(await stopping, true);
  assert.equal(storageCloses, 1);
  assert.deepEqual(
    records.map((event) => event.event),
    ["api.stopping", "api.stopped"],
  );
});

test("failed HTTP close still attempts storage cleanup and reports safe failure", async () => {
  const { logger, records } = captured();
  let closed = 0;
  const shutdown = createShutdown(
    {
      close: (callback) => callback(new Error("DO_NOT_LEAK_HTTP")),
      closeAllConnections() {},
    },
    async () => {
      closed++;
      throw new Error("DO_NOT_LEAK_DATABASE");
    },
    logger,
  );
  assert.equal(await shutdown("SIGINT"), false);
  assert.equal(closed, 1);
  assert.equal(records.at(-1).reason, "cleanup_failed");
  assert.ok(!JSON.stringify(records).includes("DO_NOT_LEAK"));
});

test("listen failure treats a never-started server as drainable", async () => {
  const { logger } = captured();
  let closes = 0;
  const shutdown = createShutdown(
    {
      close: (callback) =>
        callback(
          Object.assign(new Error(), { code: "ERR_SERVER_NOT_RUNNING" }),
        ),
      closeAllConnections() {},
    },
    async () => {
      closes++;
    },
    logger,
  );
  assert.equal(await shutdown("listen_failed"), true);
  assert.equal(closes, 1);
});

for (const hanging of ["http", "storage"]) {
  test(`shutdown deadline bounds hanging ${hanging} and forces nonzero exit`, async () => {
    const { logger, records } = captured();
    let completeHttp;
    let completeStorage;
    let closeAll = 0;
    let closes = 0;
    let forced;
    const exited = new Promise((resolve) => (forced = resolve));
    const shutdown = createShutdown(
      {
        close: (callback) => {
          completeHttp = callback;
          if (hanging === "storage") callback();
        },
        closeAllConnections: () => closeAll++,
      },
      () => {
        closes++;
        return hanging === "storage"
          ? new Promise((resolve) => (completeStorage = resolve))
          : Promise.resolve();
      },
      logger,
      { timeoutMs: 10, forceExit: forced },
    );
    const stopping = shutdown("SIGTERM");
    assert.equal(await exited, 1);
    assert.equal(closeAll, 1);
    assert.equal(closes, 1);
    if (hanging === "http") completeHttp();
    else completeStorage();
    assert.equal(await stopping, false);
    assert.equal(records.at(-1).reason, "timeout");
    assert.equal(
      records.filter((entry) => entry.event === "api.stopped").length,
      0,
    );
  });
}

test("invalid shutdown deadlines fail immediately", () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 60001, 1.5])
    assert.throws(
      () =>
        createShutdown(
          {},
          async () => {},
          () => {},
          { timeoutMs },
        ),
      RangeError,
    );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(
    `real entry-point ${signal} handler drains and allows clean process exit`,
    { timeout: 7000 },
    async (t) => {
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const port = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("./fixtures/shutdown-process.mjs", import.meta.url),
          ),
        ],
        {
          env: {
            ...(process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
            NODE_ENV: "test",
            API_HOST: "127.0.0.1",
            API_PORT: String(port),
            DATABASE_URL: "postgresql://demo:dummy@127.0.0.1:1/demo",
            PG_CONNECTION_TIMEOUT_MS: "50",
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          windowsHide: true,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const closed = once(child, "close");
      t.after(async () => {
        child.kill();
        await closed;
      });
      for (
        let attempt = 0;
        attempt < 100 && !stdout.includes('"api.started"');
        attempt++
      ) {
        assert.equal(child.exitCode, null, stderr);
        await delay(25);
      }
      assert.ok(stdout.includes('"api.started"'), stderr);
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(
        (await response.json()).error.details.storage.status,
        "down",
      );
      child.send(signal);
      const [code] = await closed;
      assert.equal(code, 0, stderr);
      const records = stdout.trim().split("\n").map(JSON.parse);
      assert.equal(
        records.find((record) => record.event === "api.stopping").reason,
        signal,
      );
      assert.equal(records.at(-1).event, "api.stopped");
      assert.ok(!stderr.includes("shutdown_failed"));
      await assert.rejects(
        fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(1000),
        }),
      );
    },
  );
}
