import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import test from "node:test";
import express from "express";
import { Client, Pool } from "pg";
import { createApp } from "../dist/app.js";
import { createLoginRouter } from "../dist/login-route.js";
import { errorHandler, requestIdMiddleware } from "../dist/http.js";
import { createLogin, LoginError } from "../dist/services/login.js";
import {
  hashPassword,
  verifyPassword,
} from "../dist/infrastructure/passwords.js";
import { createJsonAuthentication } from "../dist/infrastructure/json/authentication.js";
import { createPostgresAuthentication } from "../dist/infrastructure/postgres-authentication.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { JsonFileStore } from "../dist/infrastructure/json/store.js";
import { createDemoData, demoId } from "../dist/demo/dataset.js";
import { createAudit } from "../dist/services/audit.js";
import { createJsonAudit } from "../dist/infrastructure/json/audit.js";
import { createPostgresAudit } from "../dist/infrastructure/postgres-audit.js";
import {
  loadMigrations,
  runMigrations,
} from "../dist/infrastructure/migrations.js";

// Synthetic test-only credentials, never an operational/demo account password.
const password = " Synthetic test password with spaces ";
let hash;
async function fixture(t) {
  hash ??= await hashPassword(password);
  const directory = await mkdtemp(join(tmpdir(), "b2b-login-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonFileStore(directory),
    data = createDemoData();
  data.users = data.users.map((u, n) => ({
    ...u,
    email: `user${n}@example.test`,
    passwordHash: hash,
    mustChangePassword: true,
  }));
  for (const [name, rows] of Object.entries(data))
    await store.replace(name, rows);
  const repository = createJsonAuthentication(store);
  const audit = createAudit(createJsonAudit(directory), randomUUID);
  return {
    directory,
    store,
    data,
    repository,
    login: createLogin(repository, verifyPassword, (input) =>
      audit.record(input),
    ),
  };
}
const credentials = (email = "user0@example.test", secret = password) => ({
  email,
  password: secret,
});
const denied = (error) =>
  error instanceof LoginError && error.code === "invalid_credentials";
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
  return `http://127.0.0.1:${server.address().port}/api/v1/auth/login`;
}
const post = (url, body, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("scrypt uses random salts, fixed versioned hashes and exact passwords; disabled/invalid hashes cannot authenticate", async () => {
  const a = await hashPassword(password),
    b = await hashPassword(password);
  assert.notEqual(a, b);
  assert.match(a, /^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(!a.includes(password));
  assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword(password.trim(), a), false);
  for (const bad of [
    null,
    "disabled",
    password,
    a + "$extra",
    a.replace("v1", "v999"),
  ])
    assert.equal(await verifyPassword(password, bad), false);
  await assert.rejects(hashPassword("x".repeat(1025)));
  await assert.rejects(hashPassword(""));
});

test("password work is process-bounded without queuing, and capacity recovers", async () => {
  const a = hashPassword("parallel synthetic one"),
    b = hashPassword("parallel synthetic two");
  await assert.rejects(hashPassword("parallel synthetic three"), /unavailable/);
  await Promise.all([a, b]);
  assert.equal(await verifyPassword("ignored", null), false);
});

test("JSON login handles all roles and normalized email without changing users; customer reads never expose private credentials", async (t) => {
  const f = await fixture(t),
    before = await readFile(join(f.directory, "users.json"));
  for (let n = 0; n < f.data.users.length; n++) {
    const result = await f.login(
      credentials(` USER${n}@EXAMPLE.TEST `),
      randomUUID(),
    );
    const user = f.data.users[n];
    assert.deepEqual(result, {
      id: user.id,
      companyId: user.companyId,
      role: user.role,
      displayName: user.displayName,
      mustChangePassword: true,
    });
  }
  const profile = await createJsonRepositories(f.store).users.listCustomers(
    { companyId: demoId(1) },
    { offset: 0, limit: 10 },
  );
  for (const user of profile.items)
    assert.deepEqual(
      Object.keys(user).sort(),
      ["id", "companyId", "displayName", "role", "status"].sort(),
    );
  assert.deepEqual(await readFile(join(f.directory, "users.json")), before);
  const events = JSON.parse(
    await readFile(join(f.directory, "audit_logs.json"), "utf8"),
  );
  assert.equal(events.length, 6);
  assert.equal(events[0].actorUserId, demoId(10));
  assert.equal(events[2].companyId, demoId(1));
  assert.ok(!JSON.stringify([events, profile]).includes(hash));
  assert.ok(!JSON.stringify(events).includes("example.test"));
});

test("unknown/wrong/disabled/inactive credentials and inactive customer companies fail generically with anonymous audit", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.login(credentials("unknown@example.test"), randomUUID()),
    denied,
  );
  await assert.rejects(
    f.login(credentials(undefined, "wrong synthetic password"), randomUUID()),
    denied,
  );
  for (const status of ["PENDING", "SUSPENDED", "REJECTED", "DEACTIVATED"]) {
    await f.store.replace(
      "users",
      f.data.users.map((u) => ({ ...u, status })),
    );
    await assert.rejects(f.login(credentials(), randomUUID()), denied);
  }
  await f.store.replace(
    "users",
    f.data.users.map((u) => ({ ...u, passwordHash: "disabled" })),
  );
  await assert.rejects(f.login(credentials(), randomUUID()), denied);
  await f.store.replace("users", f.data.users);
  await f.store.replace(
    "companies",
    f.data.companies.map((c) => ({ ...c, status: "SUSPENDED" })),
  );
  await assert.rejects(
    f.login(credentials("user2@example.test"), randomUUID()),
    denied,
  );
  await f.store.replace("users", createDemoData().users);
  await assert.rejects(f.login(credentials(), randomUUID()), denied);
  const events = JSON.parse(
    await readFile(join(f.directory, "audit_logs.json"), "utf8"),
  );
  for (const event of events) {
    assert.equal(event.actorUserId, null);
    assert.equal(event.targetId, null);
    assert.equal(event.companyId, null);
    assert.equal(event.metadata.reasonCode, "INVALID_CREDENTIALS");
  }
});

test("invalid input never reaches credential storage; required storage/audit failures are unavailable without leaking details", async (t) => {
  const f = await fixture(t);
  const noIo = createLogin(
    {
      async findByEmail() {
        assert.fail("invalid input reached storage");
      },
    },
    verifyPassword,
    async () => assert.fail(),
  );
  for (const input of [
    null,
    [],
    {},
    credentials("bad"),
    credentials(undefined, ""),
    credentials(undefined, "é".repeat(513)),
    { ...credentials(), role: "INTERNAL_ADMIN" },
  ])
    await assert.rejects(
      noIo(input, randomUUID()),
      (e) => e.code === "invalid_input",
    );
  for (const login of [
    createLogin(
      {
        async findByEmail() {
          throw new Error("DO_NOT_LEAK");
        },
      },
      verifyPassword,
      async () => {},
    ),
    createLogin(f.repository, verifyPassword, async () => {
      throw new Error("DO_NOT_LEAK");
    }),
    createLogin(
      f.repository,
      async () => {
        throw new Error("DO_NOT_LEAK");
      },
      async () => {},
    ),
  ])
    await assert.rejects(
      login(credentials(), randomUUID()),
      (e) => e.code === "unavailable" && !e.message.includes("DO_NOT_LEAK"),
    );
  await assert.rejects(
    f.store.replace("users", [
      ...f.data.users,
      { ...f.data.users[0], id: demoId(99), email: "USER0@example.test" },
    ]),
  );
  await assert.rejects(
    f.store.replace("users", [
      { ...f.data.users[0], mustChangePassword: undefined },
    ]),
  );
});

test("actual HTTP login returns safe envelopes/no session, hides failures and redacts credential/audit data from request logs", async (t) => {
  const f = await fixture(t),
    logs = [],
    url = await serve(
      t,
      createApp({
        login: f.login,
        logger: (_level, event) => logs.push(event),
      }),
    );
  const response = await post(url, credentials());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  const success = await response.json();
  assert.equal(success.requestId, response.headers.get("x-request-id"));
  assert.deepEqual(Object.keys(success.data), ["user"]);
  assert.equal(success.data.user.mustChangePassword, true);
  const wrong = await post(
      url,
      credentials(undefined, "wrong synthetic password"),
    ),
    unknown = await post(url, credentials("unknown@example.test"));
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual((await wrong.json()).error, (await unknown.json()).error);
  for (const sensitive of [
    password,
    hash,
    "example.test",
    "passwordHash",
    "mustChangePassword",
  ])
    assert.ok(!JSON.stringify(logs).includes(sensitive));
  assert.ok(!JSON.stringify(success).includes(hash));
  await rm(join(f.directory, "users.json"));
  const broken = await post(url, credentials());
  assert.equal(broken.status, 503);
  assert.equal((await broken.json()).error.code, "LOGIN_UNAVAILABLE");
});

test("HTTP rejects malformed/oversized/compressed/non-JSON requests and bounds repeated attempts without trusting forwarded IP", async (t) => {
  const f = await fixture(t),
    url = await serve(t, createApp({ login: f.login, logger: () => {} }));
  assert.equal((await post(url, {})).status, 400);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(
    (await post(url, credentials(undefined, "x".repeat(5000)))).status,
    413,
  );
  assert.equal(
    (await post(url, credentials(), { "content-type": "text/plain" })).status,
    415,
  );
  assert.equal(
    (await post(url, credentials(), { "content-encoding": "gzip" })).status,
    415,
  );
  for (let n = 5; n < 10; n++)
    assert.equal(
      (await post(url, {}, { "x-forwarded-for": `192.0.2.${n}` })).status,
      400,
    );
  const limited = await post(url, credentials());
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(limited.headers.get("cache-control"), "no-store");
});

test("the local attempt window expires and permits work again", async (t) => {
  let time = 0,
    count = 0;
  const app = express();
  app.use(requestIdMiddleware);
  app.use(
    createLoginRouter(
      async () => {
        count++;
        throw new LoginError("invalid_credentials");
      },
      () => time,
    ),
  );
  app.use(errorHandler);
  const url = await serve(t, app);
  for (let n = 0; n < 10; n++)
    assert.equal((await post(url, credentials())).status, 401);
  assert.equal((await post(url, credentials())).status, 429);
  assert.equal(count, 10);
  time = 60000;
  assert.equal((await post(url, credentials())).status, 401);
  assert.equal(count, 11);
});

test("actual API entry point composes selected JSON credentials and persisted login audit", async (t) => {
  const f = await fixture(t),
    reservation = createServer();
  reservation.listen(0, "127.0.0.1");
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
        API_HOST: "127.0.0.1",
        API_PORT: String(port),
        JSON_DATA_DIR: f.directory,
        AUTH_JWT_ISSUER: "b2b-test",
        AUTH_JWT_AUDIENCE: "b2b-test",
        AUTH_JWT_ACTIVE_KID: "synthetic",
        AUTH_JWT_KEYS: JSON.stringify({
          synthetic: Buffer.alloc(32, 7).toString("base64url"),
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "",
    errorOutput = "",
    spawnError;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errorOutput += chunk;
  });
  t.after(async () => {
    child.kill();
    await closed;
  });
  for (let n = 0; n < 100 && !output.includes('"event":"api.started"'); n++) {
    assert.ifError(spawnError);
    assert.equal(child.exitCode, null, errorOutput);
    await delay(25);
  }
  assert.ok(output.includes('"event":"api.started"'), errorOutput);
  const response = await post(
    `http://127.0.0.1:${port}/api/v1/auth/login`,
    credentials("user2@example.test"),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.user.companyId, demoId(1));
  const events = JSON.parse(
    await readFile(join(f.directory, "audit_logs.json"), "utf8"),
  );
  assert.ok(events.some((event) => event.action === "login.succeeded"));
  assert.equal(events.at(-1).action, "session.issued");
  assert.equal(events.at(-1).actorUserId, f.data.users[2].id);
  assert.ok(![output, errorOutput].join().includes(hash));
  assert.ok(![output, errorOutput].join().includes("example.test"));
});

test(
  "real PostgreSQL and JSON credentials yield the same principal/failures and private audit, with no user writes",
  {
    skip: process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL
      ? false
      : "Set B2B_TEST_MIGRATIONS_CLI_DATABASE_URL",
    timeout: 30000,
  },
  async (t) => {
    const f = await fixture(t),
      url = new URL(process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL),
      admin = new Client({ connectionString: url.href });
    await admin.connect();
    const name = `b2b_login_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.href }),
      client = await pool.connect();
    t.after(async () => {
      client.release();
      await pool.end();
      try {
        await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
    });
    await runMigrations(
      client,
      await loadMigrations(new URL("../migrations/", import.meta.url)),
    );
    for (const c of f.data.companies)
      await client.query(
        "INSERT INTO companies(id,legal_name,trade_name,status) VALUES($1,$2,$3,$4)",
        [c.id, c.legalName, c.tradeName, c.status],
      );
    for (const u of f.data.users)
      await client.query(
        "INSERT INTO users(id,company_id,email,password_hash,display_name,role,status,must_change_password) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          u.id,
          u.companyId,
          u.email,
          u.passwordHash,
          u.displayName,
          u.role,
          u.status,
          u.mustChangePassword,
        ],
      );
    const before = (await client.query("SELECT * FROM users ORDER BY id")).rows;
    const repository = createPostgresAuthentication(pool),
      audit = createAudit(createPostgresAudit(pool), randomUUID),
      login = createLogin(repository, verifyPassword, (input) =>
        audit.record(input),
      );
    for (const n of [0, 2, 5])
      assert.deepEqual(
        await login(credentials(`user${n}@example.test`), randomUUID()),
        await f.login(credentials(`user${n}@example.test`), randomUUID()),
      );
    for (const input of [
      credentials("unknown@example.test"),
      credentials(undefined, "wrong synthetic password"),
    ])
      await assert.rejects(login(input, randomUUID()), denied);
    assert.deepEqual(
      (await client.query("SELECT * FROM users ORDER BY id")).rows,
      before,
    );
    await client.query("UPDATE companies SET status='SUSPENDED'");
    await assert.rejects(
      login(credentials("user2@example.test"), randomUUID()),
      denied,
    );
    await client.query(
      "UPDATE users SET status='DEACTIVATED' WHERE company_id IS NULL",
    );
    await assert.rejects(login(credentials(), randomUUID()), denied);
    const events = (await client.query("SELECT * FROM audit_logs")).rows;
    assert.equal(events.length, 7);
    assert.ok(!JSON.stringify(events).includes(hash));
    assert.ok(!JSON.stringify(events).includes("example.test"));
    await client.query("DROP TABLE audit_logs");
    await assert.rejects(
      login(credentials("user5@example.test"), randomUUID()),
      (e) => e.code === "unavailable",
    );
  },
);
