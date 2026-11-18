import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { Pool } from "pg";
import { parsePostgresEnvironment } from "@b2b-portal/config/server";
import { authFixture, barrier } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createDiagnostics } from "../dist/services/diagnostics.js";
import { selectStorage } from "../dist/infrastructure/storage.js";
import { createPostgres } from "../dist/infrastructure/postgres.js";
import { createErpHealthProbe } from "../dist/services/erp-health.js";
import { MockErpAdapter } from "../dist/infrastructure/mock-erp-adapter.js";
import { createApp } from "../dist/app.js";
const denied = (e) =>
  e.name === "AuthorizationError" ||
  ["invalid_proof", "restricted"].includes(e.code);
const sql = { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL };
async function actor(overrides = {}) {
  return createAuthorization(async () => ({
    userId: randomUUID(),
    sessionId: randomUUID(),
    role: "INTERNAL_ADMIN",
    companyId: null,
    mustChangePassword: false,
    accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
    ...overrides,
  })).admit("synthetic", "profile.read");
}
const sources = (patch = {}) => ({
  storage: { provider: "json", probe: async () => true },
  database: { configured: false },
  erp: { provider: null },
  ...patch,
});
async function fixture(t, provider = "json") {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.actor = async () =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login()).accessToken,
      "diagnostics.read",
    );
  return f;
}
async function serve(t, f, diagnostics, extra = {}) {
  const logs = [];
  const server = createApp({
    sessions: f.auth,
    diagnostics,
    logger: (level, event) => logs.push({ level, event }),
    ...extra,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, logs };
}
const get = (url, token, extra = {}) =>
  fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...extra,
  });
function exact(report) {
  assert.deepEqual(Object.keys(report).sort(), ["database", "erp", "storage"]);
  assert.deepEqual(Object.keys(report.storage).sort(), ["provider", "status"]);
  assert.deepEqual(Object.keys(report.database).sort(), [
    "configured",
    "provider",
    "status",
  ]);
  assert.deepEqual(Object.keys(report.erp).sort(), ["provider", "status"]);
}
test("service captures only configured providers, projects fixed statuses and refuses copied/expired actors before probes", async () => {
  let calls = 0;
  const config = sources({
    storage: {
      provider: "json",
      probe: async () => {
        calls++;
        return { password: "PRIVATE_PROBE_PAYLOAD" };
      },
    },
    database: {
      configured: true,
      probe: () => assert.fail("unselected SQL must not run"),
    },
    erp: {
      provider: "mock",
      probe: () => {
        throw new Error("PRIVATE_RAW_ERP_ERROR");
      },
    },
  });
  const service = createDiagnostics(config, 50);
  config.storage.provider = "PRIVATE_PROVIDER";
  config.erp.provider = "PRIVATE_PROVIDER";
  const a = await actor();
  await assert.rejects(service.report({ ...a }), denied);
  const expired = await actor({
    accessExpiresAt: new Date(Date.now() - 1).toISOString(),
  });
  await assert.rejects(service.report(expired), denied);
  const invalid = await actor({ accessExpiresAt: "not a timestamp" });
  await assert.rejects(service.report(invalid), denied);
  assert.equal(calls, 0);
  const report = await service.report(a);
  assert.deepEqual(report, {
    storage: { provider: "json", status: "down" },
    database: {
      provider: "postgresql",
      configured: true,
      status: "not_in_use",
    },
    erp: { provider: "mock", status: "down" },
  });
  exact(report);
  assert.equal(calls, 1);
  for (const limit of [0, 1001, NaN, 1.1])
    assert.throws(
      () => createDiagnostics(sources(), limit),
      /Invalid diagnostics configuration/,
    );
});
test("timeouts abort probes, bound parallel latency and retain a single slot until abandoned underlying work settles", async () => {
  const a = await actor(),
    release = barrier();
  let calls = 0,
    aborts = 0;
  const probe = async (signal) => {
    calls++;
    signal.addEventListener("abort", () => aborts++, { once: true });
    await release.promise;
    return true;
  };
  const service = createDiagnostics(
    sources({
      storage: { provider: "postgresql", probe },
      database: { configured: true, probe },
      erp: { provider: "mock", probe },
    }),
    25,
  );
  const first = service.report(a);
  await assert.rejects(service.report(a), (e) => e.code === "busy");
  const report = await first;
  assert.equal(report.storage.status, "timeout");
  assert.equal(report.database.status, "timeout");
  assert.equal(report.erp.status, "timeout");
  assert.equal(calls, 3);
  assert.equal(aborts, 3);
  for (let i = 0; i < 4; i++)
    await assert.rejects(service.report(a), (e) => e.code === "busy");
  assert.equal(calls, 3);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.report(a)).storage.status, "up");
});
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" &&
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
  };
  test(
    `${provider}: HTTP diagnostics admit only normal Internal Admin and reject all client selectors before probes`,
    options,
    async (t) => {
      const f = await fixture(t, provider);
      let calls = 0;
      const diagnostics = createDiagnostics(
        sources({
          storage: {
            provider: "json",
            probe: async () => {
              calls++;
              return true;
            },
          },
        }),
        100,
        f.now,
      );
      const { url, logs } = await serve(t, f, diagnostics),
        path = url + "/api/v1/admin/diagnostics";
      assert.equal((await get(path)).status, 401);
      for (const i of [1, 2, 3])
        assert.equal(
          (await get(path, (await f.login(i)).accessToken)).status,
          403,
        );
      assert.equal(calls, 0);
      await f.setUser({ mustChangePassword: true });
      assert.equal(
        (await get(path, (await f.login()).accessToken)).status,
        403,
      );
      await f.setUser({ mustChangePassword: false });
      const token = (await f.login()).accessToken;
      for (const query of [
        "?provider=json",
        "?database=postgresql",
        "?role=INTERNAL_ADMIN",
        "?offset=0",
        "?url=http://PRIVATE_TARGET",
        "?x[a]=1",
        "?x=1&x=2",
      ]) {
        const r = await get(path + query, token);
        assert.equal(r.status, 400);
        assert.equal((await r.json()).error.code, "INVALID_DIAGNOSTICS_QUERY");
      }
      assert.equal(calls, 0);
      const response = await get(path, token);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      exact(body.data);
      assert.ok(body.requestId);
      assert.equal((await get(path, token, { method: "HEAD" })).status, 200);
      assert.equal((await get(path, token, { method: "POST" })).status, 404);
      assert.ok(!JSON.stringify(logs).includes(token));
      assert.ok(!JSON.stringify(logs).includes("PRIVATE_TARGET"));
      const unavailable = await serve(t, f, undefined);
      const r = await get(unavailable.url + "/api/v1/admin/diagnostics", token);
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error.code, "DIAGNOSTICS_UNAVAILABLE");
    },
  );
  test(
    `${provider}: current role/status/credential/session/restriction changes during probes deny disclosure`,
    options,
    async (t) => {
      for (const kind of [
        "role",
        "status",
        "credential",
        "revoke",
        "restricted",
        "expiry",
      ]) {
        await t.test(kind, async (t) => {
          const f = await fixture(t, provider),
            token = (await f.login()).accessToken,
            entered = barrier(),
            release = barrier();
          const diagnostics = createDiagnostics(
            sources({
              storage: {
                provider: "json",
                probe: async () => {
                  entered.resolve();
                  await release.promise;
                  return true;
                },
              },
            }),
            1000,
            f.now,
          );
          const { url } = await serve(t, f, diagnostics);
          const request = get(url + "/api/v1/admin/diagnostics", token);
          await entered.promise;
          if (kind === "expiry")
            f.clock.value = Date.parse(
              (await f.auth.authenticateAccess(token)).accessExpiresAt,
            );
          else if (kind === "revoke") await f.auth.revoke(token, randomUUID());
          else {
            const patch =
              kind === "role"
                ? { role: "SALES_STAFF" }
                : kind === "status"
                  ? { status: "SUSPENDED" }
                  : kind === "restricted"
                    ? { mustChangePassword: true }
                    : {
                        passwordHash:
                          "scrypt-v1$" + "a".repeat(32) + "$" + "b".repeat(64),
                      };
            if (provider === "json") await f.setUser(patch);
            else {
              const column = {
                role: "role",
                status: "status",
                mustChangePassword: "must_change_password",
                passwordHash: "password_hash",
              }[Object.keys(patch)[0]];
              await f.pool.query(`UPDATE users SET ${column}=$1 WHERE id=$2`, [
                Object.values(patch)[0],
                f.data.users[0].id,
              ]);
            }
          }
          release.resolve();
          const r = await request;
          assert.ok([401, 403].includes(r.status));
          const body = await r.json();
          assert.equal(body.success, false);
          assert.equal(body.data, undefined);
        });
      }
    },
  );
  test(
    `${provider}: hard access expiry is enforced before probes and at/after second admission waits despite JWT tolerance`,
    options,
    async (t) => {
      const f = await fixture(t, provider),
        token = (await f.login()).accessToken,
        principal = await f.auth.authenticateAccess(token);
      let calls = 0;
      const diagnostics = createDiagnostics(
        sources({
          storage: {
            provider: "json",
            probe: async () => {
              calls++;
              return true;
            },
          },
        }),
        100,
        f.now,
      );
      const first = await serve(t, f, diagnostics);
      f.clock.value = Date.parse(principal.accessExpiresAt);
      assert.equal(
        (await get(first.url + "/api/v1/admin/diagnostics", token)).status,
        401,
      );
      assert.equal(calls, 0);
      f.clock.value -= 1000;
      const entered = barrier(),
        release = barrier();
      let admissions = 0;
      const sessions = {
        ...f.auth,
        authenticateAccess: async (value) => {
          const result = await f.auth.authenticateAccess(value);
          if (++admissions === 2) {
            entered.resolve();
            await release.promise;
          }
          return result;
        },
      };
      const second = await serve(t, f, diagnostics, { sessions });
      const request = get(second.url + "/api/v1/admin/diagnostics", token);
      await entered.promise;
      assert.equal(calls, 1);
      f.clock.value = Date.parse(principal.accessExpiresAt);
      release.resolve();
      assert.equal((await request).status, 401);
    },
  );
}
for (const configured of [false, true])
  test(`JSON selection: configured=${configured}, database not_in_use never recreates/reuses retired PostgreSQL`, async (t) => {
    const f = await fixture(t),
      a = await f.actor();
    let selections = 0,
      pgChecks = 0,
      closed = 0;
    const config = configured
      ? parsePostgresEnvironment({
          DATABASE_URL: "postgresql://synthetic@127.0.0.1:35487/postgres",
        })
      : undefined;
    const runtime = await selectStorage(
      {
        postgres: config,
        jsonDirectory: f.directory,
        startupTimeoutMs: 100,
        logger: () => {},
      },
      () => {
        selections++;
        return {
          get pool() {
            return assert.fail("unselected pool accessed");
          },
          health: async () => {
            pgChecks++;
            return false;
          },
          close: async () => {
            closed++;
          },
        };
      },
    );
    t.after(() => runtime.close());
    const before = { ...(await fs.stat(join(f.directory, "companies.json"))) };
    const diagnostics = createDiagnostics(
      {
        storage: { provider: runtime.provider, probe: runtime.health },
        database: {
          configured: runtime.databaseConfigured,
          probe: runtime.databaseHealth,
        },
        erp: { provider: null },
      },
      100,
      f.now,
    );
    assert.equal(runtime.provider, "json");
    assert.equal(runtime.databaseHealth, undefined);
    assert.equal(runtime.databaseConfigured, configured);
    for (let i = 0; i < 3; i++) {
      const report = await diagnostics.report(a);
      assert.equal(report.storage.status, "up");
      assert.deepEqual(report.database, {
        provider: "postgresql",
        configured,
        status: "not_in_use",
      });
      assert.deepEqual(report.erp, { provider: null, status: "unconfigured" });
    }
    assert.equal(selections, configured ? 1 : 0);
    assert.equal(pgChecks, configured ? 1 : 0);
    assert.equal(closed, configured ? 1 : 0);
    assert.equal(
      (await fs.stat(join(f.directory, "companies.json"))).mtimeMs,
      before.mtimeMs,
    );
    await fs.writeFile(join(f.directory, "products.json"), "{broken");
    const report = await diagnostics.report(a);
    assert.equal(report.storage.status, "down");
    assert.equal(report.database.status, "not_in_use");
    assert.equal(runtime.provider, "json");
    assert.equal(pgChecks, configured ? 1 : 0);
  });
test(
  "real selected PostgreSQL separates SELECT1 connectivity from missing-schema readiness without mutation or reselection",
  sql,
  async (t) => {
    const f = await fixture(t, "postgresql"),
      a = await f.actor();
    let selections = 0;
    const config = parsePostgresEnvironment({
      DATABASE_URL: process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
    });
    const runtime = await selectStorage(
      {
        postgres: config,
        jsonDirectory: f.directory,
        startupTimeoutMs: 1000,
        logger: () => {},
        requireSessions: true,
      },
      () => {
        selections++;
        return createPostgres(
          config,
          () => {},
          () => new Pool({ ...f.pool.options }),
        );
      },
    );
    t.after(() => runtime.close());
    const diagnostics = createDiagnostics(
      {
        storage: { provider: runtime.provider, probe: runtime.health },
        database: {
          configured: runtime.databaseConfigured,
          probe: runtime.databaseHealth,
        },
        erp: { provider: null },
      },
      1000,
      f.now,
    );
    let report = await diagnostics.report(a);
    assert.equal(report.storage.status, "up");
    assert.equal(report.database.status, "up");
    const before = (
      await f.pool.query("SELECT count(*)::int AS count FROM companies")
    ).rows[0];
    await f.pool.query("ALTER TABLE products RENAME TO unavailable_products");
    report = await diagnostics.report(a);
    assert.equal(report.database.status, "up");
    assert.equal(report.storage.status, "down");
    assert.equal(report.storage.provider, "postgresql");
    assert.equal(selections, 1);
    assert.deepEqual(
      (await f.pool.query("SELECT count(*)::int AS count FROM companies"))
        .rows[0],
      before,
    );
    const { url } = await serve(t, f, diagnostics, {
        storageProvider: runtime.provider,
        healthChecks: { storage: runtime.health },
      }),
      token = (await f.login()).accessToken;
    const r = await get(url + "/api/v1/admin/diagnostics", token);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).data.database.status, "up");
    const publicHealth = await get(url + "/health");
    assert.equal(publicHealth.status, 503);
    const publicBody = await publicHealth.json();
    assert.equal(publicBody.error.details.storage.status, "down");
    assert.equal(publicBody.error.details.database, undefined);
    await f.pool.query("ALTER TABLE unavailable_products RENAME TO products");
    assert.equal((await diagnostics.report(a)).storage.status, "up");
  },
);
test("real ERP health adapter supplies mock identity and bounded/redacted availability; degraded diagnostics remain HTTP200", async (t) => {
  const f = await fixture(t),
    token = (await f.login()).accessToken;
  let mode = "up",
    requests = 0;
  const mock = createServer((_r, response) => {
    requests++;
    if (mode === "stall") return;
    response.setHeader("content-type", "application/json");
    response.end(
      mode === "up"
        ? JSON.stringify({
            status: "up",
            password: "PRIVATE_ERP_PASSWORD",
            provider: "PRIVATE_PROVIDER",
          })
        : "PRIVATE_BAD_JSON",
    );
  }).listen(0, "127.0.0.1");
  await once(mock, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        mock.close(resolve);
        mock.closeAllConnections();
      }),
  );
  const probe = createErpHealthProbe(
    new MockErpAdapter({
      baseUrl: `http://127.0.0.1:${mock.address().port}/mock/`,
      timeoutMs: 1000,
    }),
  );
  const diagnostics = createDiagnostics(
      sources({ erp: { provider: "mock", probe } }),
      30,
      f.now,
    ),
    { url, logs } = await serve(t, f, diagnostics);
  for (const [value, status] of [
    ["up", "up"],
    ["bad", "down"],
    ["stall", "timeout"],
  ]) {
    mode = value;
    const response = await get(url + "/api/v1/admin/diagnostics", token);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.erp, { provider: "mock", status });
    assert.ok(!JSON.stringify(body).includes("PRIVATE"));
  }
  assert.equal(requests, 3);
  assert.ok(!JSON.stringify(logs).includes("PRIVATE"));
});
test("HTTP busy responses are bounded and contain neither callback errors nor diagnostics snapshots", async (t) => {
  const f = await fixture(t),
    token = (await f.login()).accessToken,
    entered = barrier(),
    release = barrier();
  let calls = 0;
  const diagnostics = createDiagnostics(
      sources({
        storage: {
          provider: "json",
          probe: async () => {
            calls++;
            entered.resolve();
            await release.promise;
            throw new Error("PRIVATE_SOURCE_FAILURE");
          },
        },
      }),
      25,
      f.now,
    ),
    { url, logs } = await serve(t, f, diagnostics),
    path = url + "/api/v1/admin/diagnostics";
  const first = get(path, token);
  await entered.promise;
  const busy = await get(path, token);
  assert.equal(busy.status, 503);
  assert.equal((await busy.json()).error.code, "DIAGNOSTICS_BUSY");
  const timed = await first;
  assert.equal(timed.status, 200);
  assert.equal((await timed.json()).data.storage.status, "timeout");
  assert.equal((await get(path, token)).status, 503);
  assert.equal(calls, 1);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const final = await get(path, token);
  assert.equal(final.status, 200);
  assert.equal((await final.json()).data.storage.status, "down");
  assert.ok(!JSON.stringify(logs).includes("PRIVATE_SOURCE_FAILURE"));
});
