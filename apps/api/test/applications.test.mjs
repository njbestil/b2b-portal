import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import {
  createApplications,
  checkedApplication,
  applicationFields,
} from "../dist/services/applications.js";
import { createJsonApplications } from "../dist/infrastructure/json/applications.js";
import { createPostgresApplications } from "../dist/infrastructure/postgres-applications.js";
import { JsonFileStore } from "../dist/infrastructure/json/store.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createJsonAuthentication } from "../dist/infrastructure/json/authentication.js";
import {
  hashPassword,
  verifyPassword,
} from "../dist/infrastructure/passwords.js";
import { createLogin } from "../dist/services/login.js";
import { createApp } from "../dist/app.js";
import {
  loadMigrations,
  runMigrations,
} from "../dist/infrastructure/migrations.js";
import { seedJson } from "../dist/demo/seed.js";
import { createJsonCatalogCache } from "../dist/infrastructure/json/catalog-cache.js";
const at = "2026-10-31T12:00:00.000Z",
  syntheticHash = `scrypt-v1$${"0".repeat(32)}$${"0".repeat(64)}`;
const input = (changes = {}) => ({
  companyName: " Synthetic Company ",
  tradeLicenseReference: " License-1 ",
  businessEmail: " BUSINESS@example.test ",
  phone: "555",
  billingAddress: "Synthetic billing",
  deliveryAddress: "Synthetic delivery",
  administratorName: "Synthetic Admin",
  administratorEmail: " ADMIN@example.test ",
  administratorMobile: "556",
  password: "synthetic temporary password",
  ...changes,
});
const record = (changes = {}) =>
  checkedApplication({
    ...applicationFields(input()),
    companyId: randomUUID(),
    administratorUserId: randomUUID(),
    deliveryAddressId: randomUUID(),
    passwordHash: syntheticHash,
    createdAt: at,
    ...changes,
  });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "b2b-applications-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, repo: createJsonApplications(directory) };
}
const read = (d, name) => readFile(join(d, name), "utf8").then(JSON.parse);

test("valid service hashes temporary credential, snapshots fields, records anonymous audit and returns only a receipt", async (t) => {
  const f = await fixture(t),
    events = [];
  const service = createApplications(
    f.repo,
    hashPassword,
    async (e) => events.push(e),
    randomUUID,
    () => new Date(at),
  );
  const body = input();
  const pending = service(body, randomUUID());
  body.administratorEmail = "mutated@example.test";
  const receipt = await pending;
  assert.deepEqual(Object.keys(receipt).sort(), ["reference", "state"]);
  assert.equal(receipt.state, "received");
  const users = await read(f.directory, "users.json"),
    companies = await read(f.directory, "companies.json");
  assert.equal(users[0].status, "PENDING");
  assert.equal(users[0].role, "CUSTOMER_ADMIN");
  assert.equal(users[0].mustChangePassword, true);
  assert.equal(companies[0].status, "PENDING");
  assert.equal(
    await verifyPassword("synthetic temporary password", users[0].passwordHash),
    true,
  );
  assert.equal(events[0].actorUserId, null);
  assert.equal(events[0].actorRole, null);
  assert.ok(!JSON.stringify(events).includes("example.test"));
  const ports = createJsonRepositories(new JsonFileStore(f.directory));
  assert.deepEqual(
    Object.keys(
      await ports.companies.findById({ companyId: companies[0].id }),
    ).sort(),
    ["id", "legalName", "tradeName", "status", "erpCustomerReference"].sort(),
  );
  assert.ok(
    !JSON.stringify(
      await ports.users.listCustomers(
        { companyId: companies[0].id },
        { offset: 0, limit: 10 },
      ),
    ).includes("passwordHash"),
  );
  const login = createLogin(
    createJsonAuthentication(new JsonFileStore(f.directory)),
    verifyPassword,
    async () => {},
  );
  await assert.rejects(
    login(
      { email: "admin@example.test", password: "synthetic temporary password" },
      randomUUID(),
    ),
    { code: "invalid_credentials" },
  );
});

test("malformed/spoofed/bounded fields reject before hash; audit failure retains Pending data and retry deduplicates", async (t) => {
  const f = await fixture(t);
  let hashes = 0,
    failAudit = true;
  const service = createApplications(
    f.repo,
    async () => {
      hashes++;
      return syntheticHash;
    },
    async () => {
      if (failAudit) throw Error("DO_NOT_LEAK");
    },
    randomUUID,
    () => new Date(at),
  );
  for (const body of [
    null,
    [],
    {},
    input({ role: "INTERNAL_ADMIN" }),
    input({ status: "ACTIVE" }),
    input({ companyId: randomUUID() }),
    input({ password: "" }),
    input({ password: "x".repeat(1025) }),
    input({ companyName: "x".repeat(201) }),
    input({ administratorEmail: "bad" }),
    input({ deliveryAddress: "bad\0" }),
  ])
    await assert.rejects(service(body, randomUUID()), {
      code: "invalid_input",
    });
  assert.equal(hashes, 0);
  await assert.rejects(
    service(input(), randomUUID()),
    (e) => e.code === "unavailable" && !e.message.includes("DO_NOT_LEAK"),
  );
  const before = await read(f.directory, "users.json");
  failAudit = false;
  await service(input(), randomUUID());
  assert.deepEqual(await read(f.directory, "users.json"), before);
});

test("JSON concurrent duplicate email/licence admission has one bundle, detached reads and complete initial address", async (t) => {
  const f = await fixture(t),
    rows = Array.from({ length: 12 }, () => record());
  await Promise.all(rows.map((r) => f.repo.submit(r)));
  const companies = await read(f.directory, "companies.json"),
    users = await read(f.directory, "users.json");
  assert.equal(companies.length, 1);
  assert.equal(users.length, 1);
  assert.equal((await read(f.directory, "delivery_addresses.json")).length, 1);
  const bundle = await f.repo.pending(companies[0].id);
  assert.equal(bundle.administratorUserId, users[0].id);
  bundle.companyName = "mutated";
  assert.equal(
    (await f.repo.pending(companies[0].id)).companyName,
    "Synthetic Company",
  );
  await f.repo.submit(record({ administratorEmail: "other@example.test" }));
  await f.repo.submit(record({ tradeLicenseReference: "OTHER" }));
  assert.equal((await read(f.directory, "companies.json")).length, 1);
  assert.ok(!(await readdir(f.directory)).includes("application_intent.json"));
});

test("JSON actual publications recover after every interruption; corrupt/conflicting/missing state refuses safely", async (t) => {
  for (const stage of [
    "intent",
    "companies",
    "users",
    "addresses",
    "complete",
  ]) {
    const f = await fixture(t),
      r = record();
    const failing = createJsonApplications(
      f.directory,
      undefined,
      async (s) => {
        if (s === stage) throw Error("crash");
      },
    );
    await assert.rejects(failing.submit(r), { code: "unavailable" });
    const reopened = createJsonApplications(f.directory);
    await reopened.recover();
    assert.equal(
      (await reopened.pending(r.companyId)).administratorUserId,
      r.administratorUserId,
    );
    await reopened.submit(record());
    assert.equal((await read(f.directory, "users.json")).length, 1);
  }
  const f = await fixture(t);
  await writeFile(join(f.directory, "application_intent.json"), "null");
  await assert.rejects(f.repo.recover(), { code: "unavailable" });
  await writeFile(
    join(f.directory, "application_intent.json"),
    JSON.stringify({ version: 1, record: { ...record(), role: "ACTIVE" } }),
  );
  await assert.rejects(f.repo.recover(), { code: "unavailable" });
  await rm(join(f.directory, "application_intent.json"));
  await writeFile(join(f.directory, "companies.json"), "[]");
  await assert.rejects(f.repo.submit(record()), { code: "unavailable" });
});

test("HTTP uses bounded no-store anonymous 202 receipts for fresh/duplicate and safe error/rate/media handling", async (t) => {
  const f = await fixture(t),
    events = [];
  const service = createApplications(
    f.repo,
    async () => syntheticHash,
    async () => {},
    randomUUID,
  );
  const server = createApp({
    applications: service,
    logger: (_level, event) => events.push(event),
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}/api/v1/customer-applications`;
  const send = (body, headers = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const a = await send(input()),
    b = await send(input());
  for (const response of [a, b]) {
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    const result = await response.json();
    assert.equal(result.data.reference, result.requestId);
    assert.deepEqual(Object.keys(result.data).sort(), ["reference", "state"]);
  }
  assert.equal((await send(input({ role: "INTERNAL_ADMIN" }))).status, 400);
  assert.equal((await send("{")).status, 400);
  assert.equal((await send("x".repeat(17000))).status, 413);
  assert.equal(
    (await send(input(), { "content-type": "text/plain" })).status,
    415,
  );
  for (let i = 0; i < 4; i++) await send(input());
  const limited = await send(input(), { "x-forwarded-for": "different" });
  assert.equal(limited.status, 429);
  assert.ok(!JSON.stringify(events).includes("example.test"));
  assert.ok(!JSON.stringify(events).includes("synthetic temporary password"));
});

test("owned demo reset/catalog refresh preserve known completed application data and refuse unresolved intent", async (t) => {
  const f = await fixture(t),
    target = join(f.directory, "b2b_demo_applications");
  await seedJson(target, {
    mode: "seed",
    confirmTarget: "b2b_demo_applications",
  });
  const repo = createJsonApplications(target),
    r = record();
  await repo.submit(r);
  const cache = createJsonCatalogCache(target, "b2b_demo_applications", true),
    before = await readFile(join(target, "users.json"), "utf8"),
    addresses = await readFile(join(target, "delivery_addresses.json"), "utf8");
  const build = ({ products }) => ({
    products,
    customer_product_access: [],
    customer_product_prices: [],
  });
  await cache.refresh(build);
  assert.equal(await readFile(join(target, "users.json"), "utf8"), before);
  assert.equal(
    await readFile(join(target, "delivery_addresses.json"), "utf8"),
    addresses,
  );
  await writeFile(join(target, "application_intent.json"), "corrupt");
  await assert.rejects(cache.refresh(build));
  await assert.rejects(
    seedJson(target, { mode: "reset", confirmTarget: "b2b_demo_applications" }),
  );
  await rm(join(target, "application_intent.json"));
  await seedJson(target, {
    mode: "reset",
    confirmTarget: "b2b_demo_applications",
  });
  await assert.rejects(readFile(join(target, "delivery_addresses.json")), {
    code: "ENOENT",
  });
});

test(
  "actual SQL/JSON Pending bundle parity, concurrent duplicates, rollback and exact private fields",
  {
    skip:
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
      "Set disposable SQL target",
    timeout: 30000,
  },
  async (t) => {
    const connectionString = process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
      admin = new Client({ connectionString });
    await admin.connect();
    const schema = `b2b_application_${randomUUID().replaceAll("-", "")}`;
    let pool;
    t.after(async () => {
      try {
        await pool?.end();
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await runMigrations(
      admin,
      await loadMigrations(new URL("../migrations/", import.meta.url)),
    );
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const sql = createPostgresApplications(pool),
      f = await fixture(t),
      r = record();
    for (const repo of [sql, f.repo]) {
      let hashes = 0;
      const apply = createApplications(
        repo,
        async () => {
          hashes++;
          return syntheticHash;
        },
        async () => {},
        randomUUID,
      );
      for (const field of ["businessEmail", "administratorEmail"])
        for (const email of unsafeEmails)
          await assert.rejects(apply(input({ [field]: email }), randomUUID()), {
            code: "invalid_input",
          });
      assert.equal(hashes, 0);
    }
    assert.equal(
      (await admin.query("SELECT count(*)::int AS n FROM companies")).rows[0].n,
      0,
    );
    assert.equal(
      (await admin.query("SELECT count(*)::int AS n FROM users")).rows[0].n,
      0,
    );
    assert.equal(
      (await admin.query("SELECT count(*)::int AS n FROM delivery_addresses"))
        .rows[0].n,
      0,
    );
    assert.deepEqual(await readdir(f.directory), []);
    assert.deepEqual(await sql.submit(r), await f.repo.submit(r));
    assert.deepEqual(
      await sql.pending(r.companyId),
      await f.repo.pending(r.companyId),
    );
    assert.equal(
      (
        await admin.query(
          "SELECT role,status,must_change_password,password_hash,mobile FROM users",
        )
      ).rows[0].password_hash,
      syntheticHash,
    );
    const duplicates = Array.from({ length: 10 }, () => record());
    await Promise.all(duplicates.map((x) => sql.submit(x)));
    assert.equal(
      (await admin.query("SELECT count(*)::int AS n FROM companies")).rows[0].n,
      1,
    );
    // Force a real failure after company publication within the transaction.
    const failed = record({
      tradeLicenseReference: "SECOND",
      administratorEmail: "second@example.test",
      administratorUserId: r.administratorUserId,
    });
    await assert.rejects(sql.submit(failed), { code: "unavailable" });
    assert.equal(
      (await admin.query("SELECT count(*)::int AS n FROM companies")).rows[0].n,
      1,
    );
    await admin.query(
      "UPDATE delivery_addresses SET active=false,is_default=false",
    );
    assert.equal(await sql.pending(r.companyId), null);
  },
);

test("capacity is bounded across hash/storage and a failed first intent write leaves no partial state", async (t) => {
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  let hashes = 0;
  const service = createApplications(
    {
      async submit(row) {
        await barrier;
        return { companyId: row.companyId };
      },
      async pending() {
        return null;
      },
    },
    async () => {
      hashes++;
      return syntheticHash;
    },
    async () => {},
    randomUUID,
  );
  const pending = Array.from({ length: 16 }, () =>
    service(input(), randomUUID()),
  );
  await assert.rejects(service(input(), randomUUID()), { code: "unavailable" });
  assert.equal(hashes, 16);
  release();
  await Promise.all(pending);
  const f = await fixture(t),
    probe = join(f.directory, "probe");
  await writeFile(probe, "");
  const handle = await open(probe, "r"),
    prototype = Object.getPrototypeOf(handle);
  await handle.close();
  await rm(probe);
  const fault = t.mock.method(prototype, "writeFile", async () => {
    throw Error("DO_NOT_LEAK");
  });
  try {
    await assert.rejects(f.repo.submit(record()), { code: "unavailable" });
    assert.deepEqual(await readdir(f.directory), []);
  } finally {
    fault.mock.restore();
  }
  await f.repo.submit(record());
  assert.equal((await read(f.directory, "companies.json")).length, 1);
});

test("same-process recovery completes its retained intent and conflicting intent cannot overwrite existing data", async (t) => {
  const f = await fixture(t);
  let once = true;
  const repo = createJsonApplications(f.directory, undefined, async (stage) => {
      if (stage === "users" && once) {
        once = false;
        throw Error("interrupted");
      }
    }),
    r = record();
  await assert.rejects(repo.submit(r), { code: "unavailable" });
  await repo.submit(record());
  assert.equal((await read(f.directory, "users.json")).length, 1);
  const before = await readFile(join(f.directory, "users.json"), "utf8");
  await writeFile(
    join(f.directory, "application_intent.json"),
    JSON.stringify({
      version: 1,
      record: { ...r, administratorEmail: "conflict@example.test" },
    }),
  );
  await assert.rejects(repo.pending(r.companyId), { code: "unavailable" });
  assert.equal(await readFile(join(f.directory, "users.json"), "utf8"), before);
  const corrupt = await fixture(t);
  await writeFile(join(corrupt.directory, "companies.json"), "null");
  await writeFile(join(corrupt.directory, "users.json"), "null");
  await assert.rejects(corrupt.repo.submit(record()), { code: "unavailable" });
});

test(
  "actual API entry point composes public JSON application intake and anonymous persisted audit",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
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
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const closed = once(child, "close");
    t.after(async () => {
      if (child.exitCode === null) child.kill();
      await closed;
    });
    const base = "http://127.0.0.1:" + port;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      assert.equal(child.exitCode, null, output);
      try {
        await fetch(base + "/", { signal: AbortSignal.timeout(1000) });
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(ready, true);
    const response = await fetch(base + "/api/v1/customer-applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input()),
    });
    assert.equal(response.status, 202);
    const receipt = await response.json();
    assert.deepEqual(Object.keys(receipt.data).sort(), ["reference", "state"]);
    const users = await read(f.directory, "users.json"),
      audit = await read(f.directory, "audit_logs.json");
    assert.equal(users.length, 1);
    assert.equal(users[0].status, "PENDING");
    assert.equal(audit[0].actorUserId, null);
    assert.equal(audit[0].action, "application.received");
    assert.ok(!output.includes("example.test"));
    assert.ok(!output.includes("synthetic temporary password"));
  },
);

const unsafeEmails = [0, 1, 127, 0xd800, 0xdc00].map(
  (n) => "unsafe" + String.fromCharCode(n) + "@example.test",
);

test("both email fields reject unsafe text before hashing or repository I/O", async () => {
  let hashes = 0,
    writes = 0,
    audits = 0;
  const apply = createApplications(
    {
      async submit() {
        writes++;
        throw Error("unexpected persistence");
      },
      async pending() {
        return null;
      },
    },
    async () => {
      hashes++;
      return syntheticHash;
    },
    async () => {
      audits++;
    },
    randomUUID,
  );
  for (const field of ["businessEmail", "administratorEmail"])
    for (const email of unsafeEmails)
      await assert.rejects(apply(input({ [field]: email }), randomUUID()), {
        code: "invalid_input",
      });
  assert.deepEqual(
    { hashes, writes, audits },
    { hashes: 0, writes: 0, audits: 0 },
  );
});

test("HTTP rejects unsafe emails consistently without hash or JSON bundle/intent publication", async (t) => {
  const f = await fixture(t);
  let hashes = 0;
  const apply = createApplications(
    f.repo,
    async () => {
      hashes++;
      return syntheticHash;
    },
    async () => {},
    randomUUID,
  );
  const server = createApp({ applications: apply, logger: () => {} }).listen(
    0,
    "127.0.0.1",
  );
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const url =
    "http://127.0.0.1:" +
    server.address().port +
    "/api/v1/customer-applications";
  for (const field of ["businessEmail", "administratorEmail"])
    for (const email of unsafeEmails) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input({ [field]: email })),
      });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).error.code, "INVALID_APPLICATION");
    }
  assert.equal(hashes, 0);
  assert.deepEqual(await readdir(f.directory), []);
});
