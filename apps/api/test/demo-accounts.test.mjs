import { Client } from "pg";
import { seedPostgres } from "../dist/demo/seed.js";
import { provisionPostgresAccounts } from "../dist/demo/accounts-postgres.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { seedJson } from "../dist/demo/seed.js";
import { createDemoData, demoId } from "../dist/demo/dataset.js";
import {
  demoAccounts,
  demoMode,
  accountPlan,
  ownedAccounts,
} from "../dist/demo/accounts.js";
import {
  provisionJsonAccounts,
  inspectJsonDemo,
} from "../dist/demo/accounts-json.js";
import {
  inspectDemoStore,
  protectDemoAuthentication,
  protectDemoTokens,
} from "../dist/demo/accounts-runtime.js";
import { verifyPassword } from "../dist/infrastructure/passwords.js";
import { JsonFileStore } from "../dist/infrastructure/json/store.js";

const target = "b2b_demo_accounts171";
const privatePassword = () => randomBytes(24).toString("base64url") + "A1!";
const modeEnv = {
  NODE_ENV: "development",
  DEMO_ACCOUNTS_ENABLED: "true",
  DEMO_DEPLOYMENT: "dedicated-demo",
  DEMO_ACCOUNTS_TARGET: target,
};
const secrets = () =>
  Object.fromEntries(demoAccounts.map((a) => [a.secret, privatePassword()]));
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "b2b171-")),
    directory = join(root, target);
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert.ok(root.includes("b2b171-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  await seedJson(directory, { mode: "seed", confirmTarget: target });
  return { root, directory, store: new JsonFileStore(directory) };
}
async function bytes(directory) {
  const result = {};
  for (const name of await fs.readdir(directory))
    result[name] = await fs.readFile(join(directory, name), "utf8");
  return result;
}
function cli(directory, env = {}, args = []) {
  const clean = {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: "",
    DEMO_ACCOUNTS_ENABLED: "",
    DEMO_DEPLOYMENT: "",
    DEMO_ACCOUNTS_TARGET: "",
  };
  return spawnSync(
    process.execPath,
    [
      "apps/api/dist/demo-accounts.js",
      "--provider",
      "json",
      "--directory",
      directory,
      "--confirm-target",
      target,
      "--offline",
      ...args,
    ],
    {
      cwd: resolve("."),
      env: { ...clean, ...env },
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    },
  );
}
async function runtime(t, directory, flags) {
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const child = spawn(process.execPath, ["apps/api/dist/index.js"], {
    cwd: resolve("."),
    env: {
      ...process.env,
      DATABASE_URL: "",
      ERP_BASE_URL: "",
      NODE_ENV: "production",
      API_HOST: "127.0.0.1",
      API_PORT: String(port),
      JSON_DATA_DIR: directory,
      STORAGE_STARTUP_TIMEOUT_MS: "5000",
      DEMO_ACCOUNTS_ENABLED: undefined,
      DEMO_DEPLOYMENT: undefined,
      DEMO_ACCOUNTS_TARGET: undefined,
      AUTH_JWT_ISSUER: "demo171-test",
      AUTH_JWT_AUDIENCE: "demo171-test",
      AUTH_JWT_ACTIVE_KID: "test",
      AUTH_JWT_KEYS: JSON.stringify({ test: runtime.key }),
      ...flags,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let logs = "";
  child.stdout.on("data", (b) => {
    logs += b;
  });
  child.stderr.on("data", (b) => {
    logs += b;
  });
  const exited = once(child, "exit");
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  t.after(stop);
  const base = "http://127.0.0.1:" + port;
  const until = Date.now() + 10000;
  while (!logs.includes("api.started")) {
    if (child.exitCode !== null || Date.now() > until) {
      await stop();
      throw Error("Runtime did not become ready (redacted)");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return { base, stop, logs: () => logs };
}
runtime.key = randomBytes(32).toString("base64url");
const login = (base, email, password) =>
  fetch(base + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
const get = (base, path, token) =>
  fetch(base + path, { headers: { authorization: "Bearer " + token } });

test("default seed remains disabled and demo gates refuse missing, partial and production configuration", async (t) => {
  const f = await fixture(t);
  assert.ok(
    (await f.store.read("users")).every((u) => u.passwordHash === undefined),
  );
  assert.equal(demoMode({ NODE_ENV: "production" }), undefined);
  assert.equal(demoMode(modeEnv), target);
  for (const patch of [
    { NODE_ENV: "production" },
    { NODE_ENV: "test" },
    { DEMO_ACCOUNTS_ENABLED: "false" },
    { DEMO_DEPLOYMENT: "production" },
    { DEMO_ACCOUNTS_TARGET: "real_database" },
    { DEMO_ACCOUNTS_TARGET: undefined },
  ]) {
    assert.throws(
      () => demoMode({ ...modeEnv, ...patch }),
      (e) => e.name === "DemoAccountsError",
    );
  }
  assert.throws(
    () => demoMode({ DEMO_ACCOUNTS_ENABLED: "true" }),
    (e) => e.name === "DemoAccountsError",
  );
  await inspectJsonDemo(f.directory, target);
  await assert.rejects(
    inspectDemoStore("b2b_demo_other", undefined, f.directory),
  );
});

test("actual operator CLI refuses unsafe/invalid configuration without leaking secrets or mutating data", async (t) => {
  const f = await fixture(t),
    before = await bytes(f.directory),
    privateEnv = secrets();
  for (const flags of [
    {},
    { ...modeEnv, NODE_ENV: "production" },
    { ...modeEnv, DEMO_DEPLOYMENT: "production" },
    { ...modeEnv, [demoAccounts[0].secret]: undefined },
  ]) {
    const result = cli(f.directory, { ...privateEnv, ...flags });
    assert.notEqual(result.status, 0);
    for (const password of Object.values(privateEnv))
      assert.equal((result.stdout + result.stderr).includes(password), false);
    assert.equal(
      JSON.stringify(await bytes(f.directory)) === JSON.stringify(before),
      true,
    );
  }
  const malformed = cli(f.directory, { ...modeEnv, ...privateEnv }, [
    "--password",
    "not-accepted",
  ]);
  assert.notEqual(malformed.status, 0);
});

test("real provisioning enables four role sign-ins, tenant/Sales boundaries, reruns, rotation and runtime opt-out", async (t) => {
  const f = await fixture(t),
    privateEnv = secrets(),
    original = await f.store.read("users");
  const unrelated = {
    id: randomUUID(),
    companyId: demoId(2),
    displayName: "Unrelated synthetic user",
    role: "CUSTOMER_USER",
    status: "ACTIVE",
  };
  await f.store.replace("users", [...original, unrelated]);
  const result = cli(f.directory, { ...modeEnv, ...privateEnv });
  assert.equal(result.status, 0, "provision command failed (redacted)");
  for (const password of Object.values(privateEnv))
    assert.equal((result.stdout + result.stderr).includes(password), false);
  const first = await f.store.read("users");
  assert.equal(
    JSON.stringify(first.find((u) => u.id === unrelated.id)) ===
      JSON.stringify(unrelated),
    true,
  );
  for (const a of demoAccounts) {
    const user = first.find((u) => u.id === a.id);
    assert.equal(
      await verifyPassword(privateEnv[a.secret], user.passwordHash),
      true,
    );
    assert.equal(JSON.stringify(user).includes(privateEnv[a.secret]), false);
  }
  const app = await runtime(t, f.directory, modeEnv),
    tokens = new Map();
  for (const a of demoAccounts) {
    const response = await login(app.base, a.email, privateEnv[a.secret]);
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.data.user.role, a.role);
    assert.equal(envelope.data.user.companyId, a.companyId);
    assert.equal(envelope.data.user.mustChangePassword, false);
    assert.equal(
      JSON.stringify(envelope).includes(privateEnv[a.secret]),
      false,
    );
    assert.equal(JSON.stringify(envelope).includes("passwordHash"), false);
    tokens.set(a.key, envelope.data);
    assert.equal(
      (await get(app.base, "/api/v1/auth/me", envelope.data.accessToken))
        .status,
      200,
    );
  }
  const companyPath = (n) => "/api/v1/companies/" + demoId(n);
  for (const role of ["customer-admin", "customer-user"]) {
    assert.equal(
      (await get(app.base, companyPath(1), tokens.get(role).accessToken))
        .status,
      200,
    );
    assert.equal(
      (await get(app.base, companyPath(2), tokens.get(role).accessToken))
        .status,
      404,
    );
    assert.equal(
      (
        await get(
          app.base,
          "/api/v1/sales/companies",
          tokens.get(role).accessToken,
        )
      ).status,
      403,
    );
  }
  const sales = tokens.get("sales-staff").accessToken;
  const listing = await get(app.base, "/api/v1/sales/companies", sales);
  assert.equal(listing.status, 200);
  assert.deepEqual(
    (await listing.json()).data.items.map((c) => c.id),
    [demoId(1)],
  );
  assert.equal((await get(app.base, companyPath(1), sales)).status, 403);
  assert.equal((await get(app.base, companyPath(2), sales)).status, 403);
  assert.equal(
    (await get(app.base, "/api/v1/catalog/products", sales)).status,
    403,
  );
  assert.equal(
    (
      await get(
        app.base,
        companyPath(2),
        tokens.get("internal-admin").accessToken,
      )
    ).status,
    200,
  );
  for (const password of Object.values(privateEnv))
    assert.equal(app.logs().includes(password), false);
  await app.stop();

  await provisionJsonAccounts(f.directory, target, "all", privateEnv, true);
  const rerun = await f.store.read("users");
  assert.equal(JSON.stringify(rerun) === JSON.stringify(first), true);
  assert.equal(
    JSON.parse(
      await fs.readFile(
        join(f.directory, "customer_sales_assignments.json"),
        "utf8",
      ),
    ).length,
    1,
  );
  const old = tokens.get("customer-user"),
    rotated = privatePassword();
  await provisionJsonAccounts(
    f.directory,
    target,
    "customer-user",
    { DEMO_CUSTOMER_USER_PASSWORD: rotated },
    true,
  );
  const after = await f.store.read("users");
  assert.equal(
    after.find((u) => u.id === demoId(31)).passwordHash !==
      first.find((u) => u.id === demoId(31)).passwordHash,
    true,
  );
  for (const a of demoAccounts.filter((a) => a.key !== "customer-user"))
    assert.equal(
      after.find((u) => u.id === a.id).passwordHash ===
        first.find((u) => u.id === a.id).passwordHash,
      true,
    );
  const restarted = await runtime(t, f.directory, modeEnv);
  assert.equal(
    (await get(restarted.base, "/api/v1/auth/me", old.accessToken)).status,
    401,
  );
  assert.equal(
    (
      await login(
        restarted.base,
        demoAccounts[3].email,
        privateEnv.DEMO_CUSTOMER_USER_PASSWORD,
      )
    ).status,
    401,
  );
  assert.equal(
    (await login(restarted.base, demoAccounts[3].email, rotated)).status,
    200,
  );
  const refresh = await fetch(restarted.base + "/api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: old.refreshToken }),
  });
  assert.equal(refresh.status, 401);
  const admin = tokens.get("internal-admin");
  await restarted.stop();

  const off = await runtime(t, f.directory, {});
  assert.equal(
    (
      await login(
        off.base,
        demoAccounts[0].email,
        privateEnv.DEMO_INTERNAL_ADMIN_PASSWORD,
      )
    ).status,
    401,
  );
  assert.equal(
    (await get(off.base, "/api/v1/auth/me", admin.accessToken)).status,
    401,
  );
  const offRefresh = await fetch(off.base + "/api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: admin.refreshToken }),
  });
  assert.equal(offRefresh.status, 401);
});

test("ownership conflicts and hash failure refuse before publication; ordinary identities retain normal behavior", async () => {
  const data = createDemoData(),
    privateEnv = secrets();
  assert.throws(() =>
    ownedAccounts(
      data.users.map((u) =>
        u.id === demoId(11) ? { ...u, role: "INTERNAL_ADMIN" } : u,
      ),
      data.companies,
      [],
    ),
  );
  assert.throws(() =>
    ownedAccounts(
      [
        ...data.users,
        { ...data.users[2], id: randomUUID(), email: demoAccounts[0].email },
      ],
      data.companies,
      [],
    ),
  );
  assert.throws(() =>
    ownedAccounts(data.users, data.companies, [
      {
        id: randomUUID(),
        companyId: demoId(2),
        salesStaffUserId: demoId(11),
        assignedByUserId: demoId(10),
        isPrimary: true,
        active: true,
        createdAt: new Date().toISOString(),
        endedAt: null,
      },
    ]),
  );
  const before = JSON.stringify(data.users);
  let calls = 0;
  await assert.rejects(
    accountPlan(
      data.users,
      data.companies,
      [],
      "all",
      privateEnv,
      undefined,
      async () => {
        calls++;
        throw Error("private failure");
      },
    ),
  );
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(data.users) === before, true);
  const ordinary = { id: demoId(10), passwordHash: "private-hash" };
  const repository = {
    findByEmail: async (email) =>
      email === "ordinary@example.test" ? ordinary : null,
  };
  assert.equal(
    (
      await protectDemoAuthentication(repository, false).findByEmail(
        "ordinary@example.test",
      )
    ).id,
    ordinary.id,
  );
  const tokens = {
    issue: async () => ({ token: "test", expiresAt: 1, expiresIn: 1 }),
    verify: async () => ({
      userId: ordinary.id,
      sessionId: randomUUID(),
      expiresAt: 1,
    }),
  };
  assert.equal(
    (await protectDemoTokens(tokens, repository, false).verify("test")).userId,
    ordinary.id,
  );
});

test("JSON publication failure restores all existing data and explicit offline/marker/link guards refuse", async (t) => {
  const f = await fixture(t),
    before = await bytes(f.directory),
    privateEnv = secrets();
  const io = {
    ...fs,
    rename: async (from, to) => {
      if (from.includes(".accounts-stage-"))
        throw Error("private publication failure");
      return fs.rename(from, to);
    },
  };
  await assert.rejects(
    provisionJsonAccounts(f.directory, target, "all", privateEnv, true, io),
    (e) => e.name === "DemoAccountsError",
  );
  assert.equal(
    JSON.stringify(await bytes(f.directory)) === JSON.stringify(before),
    true,
  );
  await assert.rejects(
    provisionJsonAccounts(f.directory, target, "all", privateEnv, false),
  );
  await fs.writeFile(join(f.directory, "unknown-file"), "unrelated");
  await assert.rejects(
    provisionJsonAccounts(f.directory, target, "all", privateEnv, true),
  );
  await fs.unlink(join(f.directory, "unknown-file"));
  await fs.writeFile(join(f.directory, ".b2b-demo"), "unowned");
  await assert.rejects(
    provisionJsonAccounts(f.directory, target, "all", privateEnv, true),
  );
  assert.equal(
    (await f.store.read("users")).every((u) => u.passwordHash === undefined),
    true,
  );
});

test("JSON refuses an existing writer lock and a linked target; safe recovery works after refusal", async (t) => {
  const f = await fixture(t),
    before = await bytes(f.directory),
    privateEnv = secrets();
  const lock = join(f.root, "." + target + ".lock");
  await fs.writeFile(lock, "owned-test-writer", { flag: "wx" });
  await assert.rejects(
    provisionJsonAccounts(f.directory, target, "all", privateEnv, true),
  );
  assert.equal(await fs.readFile(lock, "utf8"), "owned-test-writer");
  await fs.unlink(lock);
  const linked = join(f.root, "b2b_demo_linked");
  await fs.symlink(
    f.directory,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    await assert.rejects(inspectJsonDemo(linked, "b2b_demo_linked"));
  } finally {
    await fs.unlink(linked);
  }
  assert.equal(
    JSON.stringify(await bytes(f.directory)) === JSON.stringify(before),
    true,
  );
  await provisionJsonAccounts(f.directory, target, "all", privateEnv, true);
  for (const account of demoAccounts) {
    const user = (await f.store.read("users")).find(
      (row) => row.id === account.id,
    );
    assert.equal(
      await verifyPassword(privateEnv[account.secret], user.passwordHash),
      true,
    );
  }
});
test(
  "real PostgreSQL: marked-only CLI setup, four roles, transactional rollback, repeat and rotation safety",
  {
    skip: !process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL
      ? "Set disposable B2B_TEST_MIGRATIONS_CLI_DATABASE_URL"
      : false,
  },
  async (t) => {
    const url = new URL(process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    const admin = new Client({ connectionString: url.href });
    await admin.connect();
    const name = "b2b_demo_171_" + randomBytes(6).toString("hex");
    await admin.query('CREATE DATABASE "' + name + '"');
    url.pathname = "/" + name;
    const client = new Client({ connectionString: url.href });
    await client.connect();
    t.after(async () => {
      await client.end();
      await admin.query('DROP DATABASE "' + name + '"');
      await admin.end();
    });
    const migration = spawnSync(
      process.execPath,
      ["apps/api/dist/migrate.js"],
      {
        cwd: resolve("."),
        env: { ...process.env, DATABASE_URL: url.href },
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      },
    );
    assert.equal(migration.status, 0, "migration failed (redacted)");
    const privateEnv = secrets();
    await assert.rejects(
      provisionPostgresAccounts(client, name, "all", privateEnv, true),
    );
    await seedPostgres(client, { mode: "seed", confirmTarget: name });
    const extraId = randomUUID();
    await client.query(
      "INSERT INTO users(id,company_id,email,password_hash,display_name,role,status) VALUES($1,$2,$3,$4,$5,'CUSTOMER_USER','ACTIVE')",
      [
        extraId,
        demoId(2),
        "unrelated171@example.test",
        "!DISABLED_DEMO_LOGIN!",
        "Unrelated synthetic user",
      ],
    );
    const before = (await client.query("SELECT * FROM users ORDER BY id")).rows;
    const failing = {
      query: async (sql, values) => {
        if (sql.startsWith("INSERT INTO customer_sales_assignments"))
          throw Error("injected assignment failure");
        return client.query(sql, values);
      },
    };
    await assert.rejects(
      provisionPostgresAccounts(failing, name, "all", privateEnv, true),
      (e) => e.name === "DemoAccountsError",
    );
    assert.equal(
      JSON.stringify(
        (await client.query("SELECT * FROM users ORDER BY id")).rows,
      ) === JSON.stringify(before),
      true,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int n FROM customer_sales_assignments",
        )
      ).rows[0].n,
      0,
    );
    const result = spawnSync(
      process.execPath,
      [
        "apps/api/dist/demo-accounts.js",
        "--provider",
        "postgresql",
        "--confirm-target",
        name,
        "--offline",
      ],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          ...modeEnv,
          DEMO_ACCOUNTS_TARGET: name,
          DATABASE_URL: url.href,
          ...privateEnv,
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 20000,
      },
    );
    assert.equal(result.status, 0, "SQL provisioning failed (redacted)");
    for (const password of Object.values(privateEnv))
      assert.equal((result.stdout + result.stderr).includes(password), false);
    const first = (await client.query("SELECT * FROM users ORDER BY id")).rows;
    await provisionPostgresAccounts(client, name, "all", privateEnv, true);
    assert.equal(
      JSON.stringify(
        (await client.query("SELECT * FROM users ORDER BY id")).rows,
      ) === JSON.stringify(first),
      true,
    );
    const extra = (
      await client.query("SELECT * FROM users WHERE id=$1", [extraId])
    ).rows[0];
    assert.equal(
      JSON.stringify(extra) ===
        JSON.stringify(before.find((u) => u.id === extraId)),
      true,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int n FROM customer_sales_assignments",
        )
      ).rows[0].n,
      1,
    );

    const f = await fixture(t),
      flags = {
        ...modeEnv,
        DEMO_ACCOUNTS_TARGET: name,
        DATABASE_URL: url.href,
      };
    const app = await runtime(t, f.directory, flags),
      tokens = new Map();
    for (const account of demoAccounts) {
      const response = await login(
        app.base,
        account.email,
        privateEnv[account.secret],
      );
      assert.equal(response.status, 200);
      const value = (await response.json()).data;
      assert.equal(value.user.role, account.role);
      assert.equal(value.user.companyId, account.companyId);
      tokens.set(account.key, value);
    }
    const sales = await get(
      app.base,
      "/api/v1/sales/companies",
      tokens.get("sales-staff").accessToken,
    );
    assert.deepEqual(
      (await sales.json()).data.items.map((c) => c.id),
      [demoId(1)],
    );
    for (const role of ["customer-admin", "customer-user"]) {
      assert.equal(
        (
          await get(
            app.base,
            "/api/v1/companies/" + demoId(1),
            tokens.get(role).accessToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await get(
            app.base,
            "/api/v1/companies/" + demoId(2),
            tokens.get(role).accessToken,
          )
        ).status,
        404,
      );
    }
    await app.stop();
    const replacement = privatePassword();
    await provisionPostgresAccounts(
      client,
      name,
      "customer-user",
      { DEMO_CUSTOMER_USER_PASSWORD: replacement },
      true,
    );
    const restart = await runtime(t, f.directory, flags);
    assert.equal(
      (
        await get(
          restart.base,
          "/api/v1/auth/me",
          tokens.get("customer-user").accessToken,
        )
      ).status,
      401,
    );
    assert.equal(
      (await login(restart.base, demoAccounts[3].email, replacement)).status,
      200,
    );
    await restart.stop();
    const off = await runtime(t, f.directory, { DATABASE_URL: url.href });
    assert.equal(
      (
        await login(
          off.base,
          demoAccounts[0].email,
          privateEnv.DEMO_INTERNAL_ADMIN_PASSWORD,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await get(
          off.base,
          "/api/v1/auth/me",
          tokens.get("internal-admin").accessToken,
        )
      ).status,
      401,
    );
    await off.stop();
  },
);
