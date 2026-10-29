import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  EnvironmentConfigurationError,
  parsePostgresEnvironment,
} from "@b2b-portal/config/server";
import { createPostgres } from "../dist/infrastructure/postgres.js";
import { createHealthReporter } from "../dist/health.js";
import { createApp } from "../dist/app.js";

const exampleUrl = "postgresql://demo:DO_NOT_LEAK_PASSWORD@127.0.0.1:5432/demo";
const config = parsePostgresEnvironment({ DATABASE_URL: exampleUrl });
const signal = () => new AbortController().signal;

function fakePool() {
  const pool = new EventEmitter();
  const releases = [];
  const queries = [];
  const client = Object.assign(new EventEmitter(), {
    query: async (sql) => {
      queries.push(sql);
      return { rows: [{ "?column?": 1 }] };
    },
    release: (destroy) => releases.push(destroy),
  });
  let connections = 0;
  let ends = 0;
  pool.connect = async () => {
    connections++;
    return client;
  };
  pool.end = async () => {
    ends++;
  };
  const records = [];
  let options;
  const postgres = createPostgres(
    config,
    (level, entry) => records.push({ level, ...entry }),
    (value) => {
      options = value;
      return pool;
    },
  );
  return {
    pool,
    client,
    postgres,
    releases,
    queries,
    records,
    options,
    connections: () => connections,
    ends: () => ends,
  };
}

test("optional PostgreSQL configuration has explicit bounded defaults", () => {
  for (const value of [undefined, "", " "])
    assert.equal(parsePostgresEnvironment({ DATABASE_URL: value }), undefined);
  assert.deepEqual(config, {
    connectionString: exampleUrl,
    max: 10,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 10000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  assert.equal(
    parsePostgresEnvironment({
      DATABASE_URL: exampleUrl,
      PG_POOL_MAX: "1",
      PG_QUERY_TIMEOUT_MS: "1",
    }).max,
    1,
  );
  assert.equal(
    parsePostgresEnvironment({
      DATABASE_URL: exampleUrl,
      PG_POOL_MAX: "100",
      PG_CONNECTION_TIMEOUT_MS: "60000",
      PG_IDLE_TIMEOUT_MS: "600000",
      PG_QUERY_TIMEOUT_MS: "60000",
    }).statement_timeout,
    60000,
  );
});

test("invalid database settings fail without leaking credentials or values", () => {
  for (const DATABASE_URL of [
    "DO_NOT_LEAK_URL",
    "https://DO_NOT_LEAK/db",
    "postgresql:///db",
    "postgresql://DO_NOT_LEAK/",
    ` ${exampleUrl}`,
    `${exampleUrl}?query_timeout=0`,
    `${exampleUrl}?statement_timeout=0`,
    `${exampleUrl}?options=-c%20statement_timeout=0`,
  ]) {
    assert.throws(
      () => parsePostgresEnvironment({ DATABASE_URL }),
      (error) =>
        error instanceof EnvironmentConfigurationError &&
        !error.message.includes("DO_NOT_LEAK"),
    );
  }
  for (const key of [
    "PG_POOL_MAX",
    "PG_CONNECTION_TIMEOUT_MS",
    "PG_IDLE_TIMEOUT_MS",
    "PG_QUERY_TIMEOUT_MS",
  ]) {
    for (const value of [
      "",
      "0",
      "-1",
      "1.5",
      "1e3",
      "Infinity",
      " 10",
      "DO_NOT_LEAK_VALUE",
      "600001",
    ]) {
      assert.throws(
        () =>
          parsePostgresEnvironment({ DATABASE_URL: exampleUrl, [key]: value }),
        (error) =>
          error instanceof EnvironmentConfigurationError &&
          error.message.includes(key) &&
          !error.message.includes("DO_NOT_LEAK"),
      );
    }
  }
});

test("one lazy pool is configured, probes SELECT 1, and closes once", async () => {
  const f = fakePool();
  assert.equal(f.connections(), 0);
  assert.deepEqual(f.options, {
    ...config,
    application_name: "b2b-portal-api",
  });
  assert.deepEqual(
    await Promise.all([
      f.postgres.health(signal()),
      f.postgres.health(signal()),
    ]),
    [true, true],
  );
  assert.equal(f.connections(), 2);
  assert.deepEqual(f.queries, ["SELECT 1", "SELECT 1"]);
  assert.deepEqual(f.releases, [false, false]);
  const first = f.postgres.close();
  assert.equal(f.postgres.close(), first);
  await first;
  assert.equal(f.ends(), 1);
  assert.equal(await f.postgres.health(signal()), false);
  assert.equal(f.connections(), 2);
});

test("query/connect failures report down, discard broken clients, and recover", async () => {
  const f = fakePool();
  const query = f.client.query;
  f.client.query = async () => {
    throw new Error("DO_NOT_LEAK_QUERY");
  };
  assert.equal(await f.postgres.health(signal()), false);
  f.client.query = query;
  assert.equal(await f.postgres.health(signal()), true);
  const connect = f.pool.connect;
  f.pool.connect = async () => {
    throw new Error("DO_NOT_LEAK_CONNECTION");
  };
  assert.equal(await f.postgres.health(signal()), false);
  f.pool.connect = connect;
  assert.equal(await f.postgres.health(signal()), true);
  assert.deepEqual(f.releases, [true, false, false]);
  f.pool.emit("error", new Error("DO_NOT_LEAK_POOL_ERROR"));
  assert.deepEqual(f.records, [
    { level: "error", event: "postgres.pool_error" },
  ]);
  await f.postgres.close();
});

test("abort destroys an active probe client once, containing late rejection", async () => {
  const f = fakePool();
  let rejectQuery;
  const started = new Promise((resolve) => {
    f.client.query = () => {
      resolve();
      return new Promise((_, reject) => {
        rejectQuery = reject;
      });
    };
  });
  const controller = new AbortController();
  const checking = f.postgres.health(controller.signal);
  await started;
  controller.abort();
  assert.deepEqual(f.releases, [true]);
  rejectQuery(new Error("DO_NOT_LEAK_LATE_ERROR"));
  assert.equal(await checking, false);
  assert.deepEqual(f.releases, [true]);
  await f.postgres.close();
});

test("aborted acquisition releases a late client; pre-aborted probes do no work", async () => {
  const f = fakePool();
  const controller = new AbortController();
  let acquire;
  f.pool.connect = () =>
    new Promise((resolve) => {
      acquire = resolve;
    });
  const checking = f.postgres.health(controller.signal);
  controller.abort();
  acquire(f.client);
  assert.equal(await checking, false);
  assert.deepEqual(f.releases, [true]);
  assert.deepEqual(f.queries, []);
  f.pool.connect = () => assert.fail("must not acquire");
  assert.equal(await f.postgres.health(controller.signal), false);
  await f.postgres.close();
});

test("health deadline aborts pool probe ownership", async () => {
  const f = fakePool();
  let rejectQuery;
  f.client.query = () =>
    new Promise((_, reject) => {
      rejectQuery = reject;
    });
  const report = await createHealthReporter(
    { storage: f.postgres.health, erp: async () => true },
    10,
  )();
  assert.equal(report.storage.status, "timeout");
  assert.deepEqual(f.releases, [true]);
  rejectQuery(new Error("late query failure"));
  await f.postgres.close();
});

test("checked-out connection errors are contained and the client is discarded", async () => {
  const f = fakePool();
  let rejectQuery;
  const started = new Promise((resolve) => {
    f.client.query = () => {
      resolve();
      return new Promise((_, reject) => {
        rejectQuery = reject;
      });
    };
  });
  const failure = new Error("DO_NOT_LEAK_CONNECTION_LOSS");
  const checking = f.postgres.health(signal());
  await started;
  try {
    assert.doesNotThrow(() => f.client.emit("error", failure));
  } finally {
    rejectQuery(failure);
    assert.equal(await checking, false);
    await f.postgres.close();
  }
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.client.listenerCount("error"), 0);
  assert.ok(!JSON.stringify(f.records).includes("DO_NOT_LEAK"));
});

async function tcpServer(t, onConnection = () => {}) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closed;
  });
  return server.address().port;
}

test("real pg driver bounds a stalled handshake and closes sockets", async (t) => {
  const port = await tcpServer(t);
  const pgConfig = parsePostgresEnvironment({
    DATABASE_URL: `postgresql://demo:dummy@127.0.0.1:${port}/demo`,
    PG_CONNECTION_TIMEOUT_MS: "50",
  });
  const postgres = createPostgres(pgConfig, () => {});
  t.after(() => postgres.close());
  assert.equal(await postgres.health(signal()), false);
  await postgres.close();
  assert.equal(postgres.pool.totalCount, 0);
});

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const isolatedEnvironment = (overrides) => ({
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: "3000",
  ...overrides,
});

test("actual entry point rejects invalid PostgreSQL configuration safely", () => {
  const child = spawnSync(process.execPath, [entry], {
    env: isolatedEnvironment({ DATABASE_URL: "DO_NOT_LEAK_URL" }),
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  const record = JSON.parse(child.stderr);
  assert.equal(record.reason, "invalid_environment");
  assert.match(record.diagnostic, /DATABASE_URL/);
  assert.ok(!child.stderr.includes("DO_NOT_LEAK"));
});

test("actual entry point wires failed pool health without JSON fallback or secrets", async (t) => {
  const databasePort = await tcpServer(t, (socket) => socket.destroy());
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const apiPort = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const child = spawn(process.execPath, [entry], {
    env: isolatedEnvironment({
      API_PORT: String(apiPort),
      DATABASE_URL: `postgresql://demo:DO_NOT_LEAK_PASSWORD@127.0.0.1:${databasePort}/demo`,
      PG_CONNECTION_TIMEOUT_MS: "50",
    }),
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
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, output);
    try {
      response = await fetch(`http://127.0.0.1:${apiPort}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      break;
    } catch {
      await delay(25);
    }
  }
  assert.ok(response, output);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.details.storage.status, "down");
  assert.equal(body.error.details.erp.status, "unconfigured");
  assert.ok(!JSON.stringify({ body, output }).includes("DO_NOT_LEAK"));
});

test(
  "optional real PostgreSQL: reuse, health, query timeout, drain",
  {
    skip:
      !process.env.B2B_TEST_DATABASE_URL &&
      "Set B2B_TEST_DATABASE_URL to a disposable PostgreSQL database",
  },
  async (t) => {
    const pgConfig = parsePostgresEnvironment({
      DATABASE_URL: process.env.B2B_TEST_DATABASE_URL,
      PG_POOL_MAX: "1",
      PG_QUERY_TIMEOUT_MS: "100",
    });
    const postgres = createPostgres(pgConfig, () => {});
    t.after(() => postgres.close());
    assert.equal(await postgres.health(signal()), true);
    const first = await postgres.pool.query("SELECT pg_backend_pid() AS pid");
    const second = await postgres.pool.query("SELECT pg_backend_pid() AS pid");
    assert.equal(first.rows[0].pid, second.rows[0].pid);
    assert.equal(postgres.pool.totalCount, 1);
    const client = await postgres.pool.connect();
    try {
      await assert.rejects(client.query("SELECT pg_sleep(1)"));
    } finally {
      client.release(true);
    }
    await postgres.close();
    assert.equal(postgres.pool.totalCount, 0);
    assert.equal(await postgres.health(signal()), false);
  },
);

test("pool probe integrates with the HTTP health envelope", async (t) => {
  const f = fakePool();
  const server = createApp({
    logger: () => {},
    healthChecks: { storage: f.postgres.health, erp: async () => true },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await f.postgres.close();
  });
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/health`,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.storage.status, "up");
});
