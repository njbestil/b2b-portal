import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { authFixture, oldPassword, barrier } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import {
  createIntegrationMonitor,
  checkedMonitorQuery,
} from "../dist/services/integration-monitor.js";
import {
  integrationStatuses,
  integrationErrorCodes,
} from "../dist/repositories/integration-monitor.js";
import { createPostgresIntegrationMonitor } from "../dist/infrastructure/postgres-integration-monitor.js";
import { createUnavailableIntegrationMonitor } from "../dist/infrastructure/unavailable-integration-monitor.js";
import { createApp } from "../dist/app.js";
const code = (value) => (e) => e.code === value;
const denied = (e) =>
  ["invalid_proof", "restricted", "forbidden"].includes(e.code) ||
  e.name === "AuthorizationError";
const signal = () => new AbortController().signal;
const id = (n) => `a8500000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sqlOpts = {
  skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
    ? "Set disposable SQL test URL"
    : false,
};
async function fixture(t, provider = "postgresql", seed = true) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.actor = async (i = 0) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(i)).accessToken,
      "profile.read",
    );
  f.repo =
    provider === "postgresql"
      ? createPostgresIntegrationMonitor(f.pool, f.now)
      : createUnavailableIntegrationMonitor();
  f.service = (repo = f.repo) => createIntegrationMonitor(repo, f.now);
  f.monitor = f.service();
  f.list = async (query = {}, a) =>
    f.monitor.list(a ?? (await f.actor()), query, signal());
  f.find = async (value, a) =>
    f.monitor.find(a ?? (await f.actor()), value, signal());
  f.orders = Array.from({ length: 4 }, (_, i) => ({
    id: id(100 + i),
    companyId: f.data.companies[i % 2].id,
    creator: f.data.users[i % 2 ? 4 : 2].id,
  }));
  if (provider === "postgresql") {
    for (const o of f.orders)
      await f.pool.query(
        "INSERT INTO orders(id,company_id,created_by_user_id,order_status,integration_status) VALUES($1,$2,$3,'SUBMITTED','PENDING')",
        [o.id, o.companyId, o.creator],
      );
    f.insert = async (n, patch = {}) => {
      const o = f.orders[n % 4],
        time = new Date(f.now() - (n < 5 ? 2000 : 1000)).toISOString();
      const row = {
        id: id(n),
        companyId: o.companyId,
        orderId: o.id,
        operation:
          n < 4
            ? "ORDER_SUBMISSION"
            : n === 8
              ? "HIDDEN_OPERATION_SECRET"
              : "PRIVATE_OPERATION_" + n,
        status: integrationStatuses[n % 6],
        retryable: n % 2 === 0,
        retryCount: n,
        nextRetryAt:
          n % 2 === 0 ? new Date(f.now() + 60000).toISOString() : null,
        errorCode:
          n < 8
            ? integrationErrorCodes[n]
            : n === 8
              ? "HIDDEN_ERROR_SECRET"
              : null,
        createdAt: time,
        updatedAt: time,
        ...patch,
      };
      await f.pool.query(
        "INSERT INTO integration_transactions(id,company_id,order_id,operation,status,retryable,retry_count,next_retry_at,error_code,created_at,updated_at,idempotency_key,request_payload,response_payload,error_message) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)",
        [
          row.id,
          row.companyId,
          row.orderId,
          row.operation,
          row.status,
          row.retryable,
          row.retryCount,
          row.nextRetryAt,
          row.errorCode,
          row.createdAt,
          row.updatedAt,
          "HIDDEN_KEY_SECRET_" + randomUUID(),
          JSON.stringify({ private: "HIDDEN_REQUEST_SECRET" }),
          JSON.stringify({ private: "HIDDEN_RESPONSE_SECRET" }),
          "HIDDEN_MESSAGE_SECRET",
        ],
      );
      return row;
    };
    if (seed) for (let i = 0; i < 10; i++) await f.insert(i);
    f.raw = async () =>
      (await f.pool.query("SELECT * FROM integration_transactions ORDER BY id"))
        .rows;
  }
  return f;
}
async function server(t, app) {
  const s = app.listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(
    () =>
      new Promise((r) => {
        s.closeAllConnections();
        s.close(r);
      }),
  );
  return { server: s, url: `http://127.0.0.1:${s.address().port}` };
}
const path = "/api/v1/admin/integration-transactions";
const get = (url, token, headers = {}) =>
  fetch(url, {
    headers: {
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...headers,
    },
  });
const data = async (response, status = 200) => {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()).data;
};

test(
  "SQL native microsecond ordering remains valid when DTO timestamps share a millisecond",
  sqlOpts,
  async (t) => {
    const f = await fixture(t, "postgresql", false);
    const older = await f.insert(0, {
        createdAt: "2026-11-19T00:00:00.000100Z",
      }),
      newer = await f.insert(1, { createdAt: "2026-11-19T00:00:00.000900Z" });
    const result = await f.list();
    assert.deepEqual(
      result.items.map((r) => r.id),
      [newer.id, older.id],
    );
    assert.equal(result.items[0].createdAt, result.items[1].createdAt);
  },
);

test(
  "SQL list/detail expose fixed safe summaries, native stable ties and filtered totals without mutating technical/business data",
  sqlOpts,
  async (t) => {
    const f = await fixture(t),
      a = await f.actor(),
      before = await f.raw(),
      orders = (await f.pool.query("SELECT * FROM orders ORDER BY id")).rows;
    const result = await f.list({}, a);
    assert.equal(result.total, 10);
    assert.equal(result.offset, 0);
    assert.equal(result.limit, 20);
    assert.deepEqual(
      result.items.map((r) => r.id),
      [5, 6, 7, 8, 9, 0, 1, 2, 3, 4].map(id),
    );
    const fields = [
      "id",
      "companyId",
      "orderId",
      "operation",
      "status",
      "retryable",
      "retryCount",
      "nextRetryAt",
      "errorCode",
      "createdAt",
      "updatedAt",
    ].sort();
    for (const row of result.items) {
      assert.deepEqual(Object.keys(row).sort(), fields);
      assert.deepEqual((await f.find(row.id, a)).transaction, row);
    }
    assert.equal(result.items.find((r) => r.id === id(8)).operation, "OTHER");
    assert.equal(
      result.items.find((r) => r.id === id(8)).errorCode,
      "UNRECOGNIZED",
    );
    assert.equal(result.items.find((r) => r.id === id(9)).errorCode, null);
    assert.deepEqual(
      (await f.list({ offset: "2", limit: "3" }, a)).items.map((r) => r.id),
      [7, 8, 9].map(id),
    );
    assert.deepEqual(await f.list({ offset: 100000 }, a), {
      items: [],
      total: 10,
      offset: 100000,
      limit: 20,
    });
    for (const status of integrationStatuses) {
      const filtered = await f.list({ status }, a);
      assert.equal(
        filtered.total,
        before.filter((r) => r.status === status).length,
      );
      assert.ok(filtered.items.every((r) => r.status === status));
    }
    const companyId = f.data.companies[0].id,
      orderId = f.orders[0].id;
    const subset = await f.list({ companyId, orderId }, a);
    assert.equal(
      subset.total,
      before.filter((r) => r.company_id === companyId && r.order_id === orderId)
        .length,
    );
    assert.deepEqual(await f.raw(), before);
    assert.deepEqual(
      (await f.pool.query("SELECT * FROM orders ORDER BY id")).rows,
      orders,
    );
    const text = JSON.stringify(result);
    for (const privateValue of [
      "HIDDEN_KEY_SECRET",
      "HIDDEN_REQUEST_SECRET",
      "HIDDEN_RESPONSE_SECRET",
      "HIDDEN_MESSAGE_SECRET",
      "HIDDEN_OPERATION_SECRET",
      "HIDDEN_ERROR_SECRET",
      f.passwordHash,
      oldPassword,
    ])
      assert.equal(text.includes(privateValue), false);
  },
);

test(
  "SQL search counts only safe projected fields and cannot reveal raw payload/key/operation/error text",
  sqlOpts,
  async (t) => {
    const f = await fixture(t),
      a = await f.actor();
    for (const q of [
      "HIDDEN_KEY_SECRET",
      "HIDDEN_REQUEST_SECRET",
      "HIDDEN_RESPONSE_SECRET",
      "HIDDEN_MESSAGE_SECRET",
      "HIDDEN_OPERATION_SECRET",
      "HIDDEN_ERROR_SECRET",
      "PRIVATE_OPERATION",
    ]) {
      const r = await f.list({ q }, a);
      assert.equal(r.total, 0);
      assert.deepEqual(r.items, []);
    }
    assert.equal((await f.list({ q: " other " }, a)).total, 6);
    assert.equal((await f.list({ q: "unrecognized" }, a)).total, 1);
    assert.equal((await f.list({ q: id(7).slice(-8) }, a)).total, 1);
    for (const errorCode of integrationErrorCodes) {
      const r = await f.list({ q: errorCode }, a);
      assert.ok(r.items.some((row) => row.errorCode === errorCode));
    }
    const filtered = await f.list(
      { q: "failed", companyId: f.data.companies[0].id },
      a,
    );
    assert.ok(
      filtered.items.every(
        (r) => r.status === "FAILED" && r.companyId === f.data.companies[0].id,
      ),
    );
  },
);

test(
  "service validates strict search/filter/page selectors before data access and rejects unsafe provider shapes",
  sqlOpts,
  async (t) => {
    const f = await fixture(t),
      a = await f.actor();
    let calls = 0;
    const mock = f.service({
      list: async () => {
        calls++;
        return { items: [], total: 0 };
      },
      find: async () => {
        calls++;
        return null;
      },
    });
    const invalid = [
      null,
      [],
      { unknown: "x" },
      { status: ["PENDING", "FAILED"] },
      { status: "pending" },
      { status: "SECRET" },
      { companyId: "bad" },
      { orderId: "bad" },
      { companyId: [] },
      { offset: "01" },
      { offset: "-1" },
      { offset: "1e2" },
      { offset: 100001 },
      { offset: 1.1 },
      { limit: 0 },
      { limit: 101 },
      { limit: "2.5" },
      { q: "" },
      { q: " " },
      { q: "x".repeat(129) },
      { q: "%" },
      { q: "' OR 1=1" },
      { q: "a\nb" },
      { q: ["FAILED", "SUCCESS"] },
    ];
    for (const query of invalid)
      await assert.rejects(
        mock.list(a, query, signal()),
        code("invalid_input"),
      );
    assert.equal(calls, 0);
    assert.deepEqual(
      checkedMonitorQuery({ q: " Abc-123_code ", offset: "2", limit: "1" }),
      { q: "Abc-123_code", offset: 2, limit: 1 },
    );
    const safe = (await f.list({ limit: 1 }, a)).items[0];
    for (const result of [
      { items: [], total: 1 },
      { items: [safe, safe], total: 2 },
      { items: [{ ...safe, retryCount: Infinity }], total: 1 },
      { items: [{ ...safe, status: "SECRET_STATUS" }], total: 1 },
      { items: [{ ...safe, createdAt: "infinity" }], total: 1 },
      { items: [], total: Infinity },
    ]) {
      const unsafe = f.service({
        list: async () => result,
        find: async () => null,
      });
      await assert.rejects(unsafe.list(a, {}, signal()), code("unavailable"));
    }
    const stripped = await f
      .service({
        list: async () => ({
          items: [{ ...safe, request_payload: "PRIVATE" }],
          total: 1,
        }),
        find: async () => ({ ...safe, error_message: "PRIVATE" }),
      })
      .list(a, {}, signal());
    assert.equal(JSON.stringify(stripped).includes("PRIVATE"), false);
    await assert.rejects(f.find(randomUUID(), a), code("not_found"));
    await assert.rejects(mock.find(a, "bad", signal()), code("invalid_input"));
  },
);

test(
  "actual SQL role/session/current credential checks deny stale capabilities and strict access expiry rejects JWT tolerance",
  sqlOpts,
  async (t) => {
    for (const scenario of [
      "role",
      "inactive",
      "restricted",
      "credential",
      "revoked",
      "hard-expiry",
      "access-expiry",
    ]) {
      await t.test(scenario, async (t) => {
        const f = await fixture(t),
          a = await f.actor();
        if (scenario === "role")
          await f.pool.query(
            "UPDATE users SET role='SALES_STAFF' WHERE id=$1",
            [a.userId],
          );
        if (scenario === "inactive") await f.setUser({ status: "SUSPENDED" });
        if (scenario === "restricted")
          await f.setUser({ mustChangePassword: true });
        if (scenario === "credential")
          await f.pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
            "scrypt-v1$" + "1".repeat(32) + "$" + "2".repeat(64),
            a.userId,
          ]);
        if (scenario === "revoked")
          await f.sessions.revoke(a.sessionId, a.userId);
        if (scenario === "hard-expiry") {
          await f.pool.query(
            "UPDATE user_sessions SET expires_at=created_at+interval '1 second' WHERE id=$1",
            [a.sessionId],
          );
          f.clock.value += 2000;
        }
        if (scenario === "access-expiry")
          f.clock.value = Date.parse(a.accessExpiresAt);
        await assert.rejects(f.list({}, a), denied);
        await assert.rejects(f.find(id(0), a), denied);
      });
    }
    const f = await fixture(t),
      token = await f.login(),
      a = await createAuthorization(f.auth.authenticateAccess).admit(
        token.accessToken,
        "profile.read",
      );
    f.clock.value = Date.parse(a.accessExpiresAt) + 1000;
    const tolerated = await createAuthorization(
      f.auth.authenticateAccess,
    ).admit(token.accessToken, "profile.read");
    await assert.rejects(f.monitor.list(tolerated, {}, signal()), denied);
  },
);

for (const provider of ["json", "postgresql"])
  test(
    provider +
      ": actual four-role HTTP access, no-store privacy, invalid selectors and provider-unavailable behavior",
    {
      skip:
        provider === "postgresql" &&
        !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
    },
    async (t) => {
      const f = await fixture(t, provider),
        logs = [],
        api = await server(
          t,
          createApp({
            sessions: f.auth,
            integrationMonitor: f.monitor,
            logger: (level, event) => logs.push({ level, event }),
          }),
        ),
        token = (await f.login()).accessToken;
      assert.equal((await get(api.url + path)).status, 401);
      for (const i of [1, 2, 3, 4, 5]) {
        const roleToken = (await f.login(i)).accessToken;
        assert.equal(
          (await get(api.url + path, roleToken, { "x-role": "INTERNAL_ADMIN" }))
            .status,
          403,
        );
        assert.equal(
          (await get(api.url + path + "/" + id(0), roleToken)).status,
          403,
        );
      }
      if (provider === "json") {
        await fs.writeFile(
          join(f.directory, "integration_transactions.json"),
          "HIDDEN_FAKE_TRANSACTION_COLLECTION",
        );
        assert.equal((await get(api.url + path, token)).status, 503);
        assert.equal(
          (await get(api.url + path + "/" + id(0), token)).status,
          503,
        );
        assert.equal(
          await fs.readFile(
            join(f.directory, "integration_transactions.json"),
            "utf8",
          ),
          "HIDDEN_FAKE_TRANSACTION_COLLECTION",
        );
      } else {
        const r = await data(
          await get(api.url + path + "?status=FAILED&limit=1", token),
        );
        assert.equal(r.items.length, 1);
        assert.equal(r.items[0].status, "FAILED");
        const detail = await data(
          await get(api.url + path + "/" + r.items[0].id, token),
        );
        assert.deepEqual(detail.transaction, r.items[0]);
        assert.equal(
          (await get(api.url + path + "/" + randomUUID(), token)).status,
          404,
        );
      }
      for (const suffix of [
        "?q=%25",
        "?q=a&q=b",
        "?status=PENDING&status=FAILED",
        "?request_payload=x",
        "?offset=01",
        "?orderId=bad",
      ]) {
        assert.equal((await get(api.url + path + suffix, token)).status, 400);
      }
      assert.equal((await get(api.url + path + "/bad", token)).status, 400);
      assert.equal(
        (await get(api.url + path + "/" + id(0) + "?q=FAILED", token)).status,
        400,
      );
      const text = JSON.stringify(logs);
      for (const privateValue of [
        "HIDDEN",
        oldPassword,
        f.passwordHash,
        "request_payload",
      ])
        assert.equal(text.includes(privateValue), false);
    },
  );
async function slowView(f, seconds) {
  await f.admin.query(
    "ALTER TABLE integration_transactions RENAME TO monitor_rows",
  );
  await f.admin.query(
    `CREATE VIEW integration_transactions AS SELECT t.* FROM monitor_rows t CROSS JOIN LATERAL (SELECT pg_sleep(${seconds})) delay`,
  );
}
async function waitForSleep(f) {
  for (let i = 0; i < 100; i++) {
    const r = await f.admin.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%projected%'",
    );
    if (r.rows[0].n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Expected actual monitor query sleep");
}

test(
  "SQL monitor reads stay read-only, tolerate concurrent row writers, and enforce server deadlines with reusable connections",
  sqlOpts,
  async (t) => {
    await t.test("row-lock independence", async (t) => {
      const f = await fixture(t),
        a = await f.actor(),
        before = await f.raw(),
        blocker = await f.pool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM integration_transactions FOR UPDATE");
      let timer;
      try {
        const result = await Promise.race([
          f.list({}, a),
          new Promise((r) => {
            timer = setTimeout(() => r(null), 1000);
          }),
        ]);
        assert.equal(result?.total, 10);
        assert.deepEqual(await f.raw(), before);
      } finally {
        clearTimeout(timer);
        await blocker.query("ROLLBACK");
        blocker.release();
      }
    });
    await t.test("bounded DDL wait", async (t) => {
      const f = await fixture(t),
        a = await f.actor(),
        blocker = await f.pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE integration_transactions IN ACCESS EXCLUSIVE MODE",
      );
      const start = Date.now();
      try {
        await assert.rejects(f.list({}, a), code("unavailable"));
        assert.ok(Date.now() - start < 2500);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      assert.equal((await f.list({}, a)).total, 10);
      assert.equal(f.pool.waitingCount, 0);
    });
    await t.test("bounded statement execution", async (t) => {
      const f = await fixture(t),
        a = await f.actor();
      await slowView(f, 3);
      const start = Date.now();
      await assert.rejects(f.list({}, a), code("unavailable"));
      assert.ok(Date.now() - start < 3500);
      await f.admin.query("DROP VIEW integration_transactions");
      await f.admin.query(
        "ALTER TABLE monitor_rows RENAME TO integration_transactions",
      );
      assert.equal((await f.list({}, a)).total, 10);
      assert.equal(f.pool.waitingCount, 0);
    });
    await t.test("database-enforced read only", async (t) => {
      const f = await fixture(t),
        a = await f.actor(),
        before = await f.raw();
      await f.admin.query(
        "ALTER TABLE integration_transactions RENAME TO monitor_rows",
      );
      await f.admin.query(
        "CREATE FUNCTION monitoring_must_not_write() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN UPDATE monitor_rows SET retry_count=retry_count+1; RETURN true; END $$",
      );
      await f.admin.query(
        "CREATE VIEW integration_transactions AS SELECT * FROM monitor_rows WHERE monitoring_must_not_write()",
      );
      await assert.rejects(f.list({}, a), code("unavailable"));
      await f.admin.query("DROP VIEW integration_transactions");
      await f.admin.query(
        "ALTER TABLE monitor_rows RENAME TO integration_transactions",
      );
      assert.deepEqual(await f.raw(), before);
      assert.equal((await f.list({}, a)).total, 10);
    });
  },
);

test(
  "SQL fresh authority after real data-query wait denies revocation/credential/role changes and strict expiry/cancellation",
  sqlOpts,
  async (t) => {
    for (const scenario of [
      "role",
      "inactive",
      "restricted",
      "credential",
      "revoked",
      "expiry",
      "abort",
    ]) {
      await t.test(scenario, async (t) => {
        const f = await fixture(t),
          a = await f.actor(),
          controller = new AbortController();
        await slowView(f, 0.4);
        const pending = f.monitor.list(a, {}, controller.signal);
        await waitForSleep(f);
        if (scenario === "role")
          await f.admin.query(
            "UPDATE users SET role='SALES_STAFF' WHERE id=$1",
            [a.userId],
          );
        if (scenario === "inactive")
          await f.admin.query(
            "UPDATE users SET status='SUSPENDED' WHERE id=$1",
            [a.userId],
          );
        if (scenario === "restricted")
          await f.admin.query(
            "UPDATE users SET must_change_password=true WHERE id=$1",
            [a.userId],
          );
        if (scenario === "credential")
          await f.admin.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
            "scrypt-v1$" + "1".repeat(32) + "$" + "2".repeat(64),
            a.userId,
          ]);
        if (scenario === "revoked")
          await f.admin.query(
            "UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE id=$1",
            [a.sessionId],
          );
        if (scenario === "expiry")
          f.clock.value = Date.parse(a.accessExpiresAt);
        if (scenario === "abort") controller.abort();
        await assert.rejects(
          pending,
          scenario === "abort" ? code("unavailable") : denied,
        );
      });
    }
    await t.test("pool checkout expiry", async (t) => {
      const f = await fixture(t),
        a = await f.actor(),
        held = await Promise.all(
          Array.from({ length: 8 }, () => f.pool.connect()),
        );
      const pending = f.list({}, a);
      for (let i = 0; i < 100 && f.pool.waitingCount !== 1; i++)
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(f.pool.waitingCount, 1);
      f.clock.value = Date.parse(a.accessExpiresAt);
      held.pop().release();
      try {
        await assert.rejects(pending, denied);
      } finally {
        for (const c of held) c.release();
      }
      assert.equal(f.pool.waitingCount, 0);
    });
  },
);

test(
  "service rejects access expiry/cancellation after awaited repository output before disclosure",
  sqlOpts,
  async (t) => {
    for (const scenario of ["expiry", "abort"]) {
      const f = await fixture(t),
        a = await f.actor(),
        controller = new AbortController(),
        entered = barrier(),
        release = barrier();
      const monitor = f.service({
        list: async () => {
          entered.resolve();
          await release.promise;
          return { items: [], total: 0 };
        },
        find: async () => null,
      });
      const pending = monitor.list(a, {}, controller.signal);
      await entered.promise;
      if (scenario === "expiry") f.clock.value = Date.parse(a.accessExpiresAt);
      else controller.abort();
      release.resolve();
      await assert.rejects(
        pending,
        scenario === "expiry" ? denied : code("unavailable"),
      );
    }
  },
);

test("HTTP disconnected reads retain four actual-operation slots until settlement; rate and missing capability are bounded", async (t) => {
  const { default: express } = await import("express"),
    f = await fixture(t, "json"),
    token = (await f.login()).accessToken,
    entered = barrier(),
    release = barrier(),
    closed = barrier(),
    fifth = barrier();
  let started = 0,
    finished = 0,
    closes = 0;
  const blocked = {
    list: async () => {
      started++;
      if (started === 4) entered.resolve();
      if (started === 5) fifth.resolve();
      try {
        await release.promise;
        return { items: [], total: 0, offset: 0, limit: 20 };
      } finally {
        finished++;
      }
    },
    find: async () => {
      throw Error("PRIVATE_NOT_CALLED");
    },
  };
  const outer = express();
  outer.use((_req, res, next) => {
    res.once("close", () => {
      if (++closes === 4) closed.resolve();
    });
    next();
  });
  outer.use(
    createApp({
      sessions: f.auth,
      integrationMonitor: blocked,
      logger: () => {},
    }),
  );
  const api = await server(t, outer),
    controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((c) =>
    fetch(api.url + path, {
      headers: { authorization: "Bearer " + token },
      signal: c.signal,
    }).catch(() => null),
  );
  await entered.promise;
  controllers.forEach((c) => c.abort());
  await Promise.all(pending);
  await closed.promise;
  const response = get(api.url + path, token);
  let timer;
  const outcome = await Promise.race([
    response.then((r) => r.status),
    fifth.promise.then(() => "fifth actual read admitted"),
    new Promise((r) => {
      timer = setTimeout(() => r("no bounded rejection"), 1000);
    }),
  ]);
  clearTimeout(timer);
  release.resolve();
  await response;
  for (let i = 0; i < 100 && finished < started; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(outcome, 503);
  assert.equal(started, 4);
  assert.equal(finished, 4);
  assert.equal((await get(api.url + path, token)).status, 200);
  const rate = await server(
    t,
    createApp({
      sessions: f.auth,
      integrationMonitor: {
        list: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
        find: async () => ({ transaction: {} }),
      },
      logger: () => {},
    }),
  );
  let limited;
  for (let i = 0; i < 31; i++) limited = await get(rate.url + path, token);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  const absent = await server(
    t,
    createApp({ sessions: f.auth, logger: () => {} }),
  );
  assert.equal((await get(absent.url + path, token)).status, 503);
});

test(
  "concurrent producer updates retain internally consistent single-snapshot page totals and fixed fields",
  sqlOpts,
  async (t) => {
    const f = await fixture(t),
      a = await f.actor();
    const updates = Array.from({ length: 15 }, (_, i) =>
      f.pool.query(
        "UPDATE integration_transactions SET status=$1 WHERE id=$2",
        [i % 2 ? "SUCCESS" : "PENDING", id(0)],
      ),
    );
    const reads = Array.from({ length: 6 }, () =>
      f.list({ status: "PENDING", limit: 100 }, a),
    );
    await Promise.all(updates);
    for (const page of await Promise.all(reads)) {
      assert.equal(page.total, page.items.length);
      assert.ok(page.items.every((r) => r.status === "PENDING"));
    }
  },
);

test(
  "real submission/retry producers are inspected while processing and after success without monitoring changing retained evidence",
  sqlOpts,
  async (t) => {
    const { createOrderDrafts } =
        await import("../dist/services/order-drafts.js"),
      { createPostgresOrderDrafts } =
        await import("../dist/infrastructure/postgres-order-drafts.js"),
      { createMockCustomerCatalogSource } =
        await import("../dist/infrastructure/mock-customer-catalog-adapter.js"),
      { createMockSubmissionAdapter } =
        await import("../dist/infrastructure/mock-submission-adapter.js"),
      { createPostgresOrderSubmission } =
        await import("../dist/infrastructure/postgres-order-submission.js"),
      { createPostgresRetryingGateway } =
        await import("../dist/infrastructure/postgres-submission-retry.js"),
      { createApp: createMock } = await import("../../mock-erp/dist/app.js");
    const f = await fixture(t, "postgresql", false),
      a = await f.actor(),
      customer = await f.actor(2),
      company = f.data.companies[0].id,
      address = randomUUID(),
      mock = await server(t, createMock()),
      config = { baseUrl: mock.url + "/mock-erp/v1/", timeoutMs: 5000 };
    await f.pool.query(
      "UPDATE companies SET erp_customer_reference='DEMO-C001' WHERE id=$1",
      [company],
    );
    await f.pool.query(
      "INSERT INTO delivery_addresses(id,company_id,label,address) VALUES($1,$2,'Synthetic',$3::jsonb)",
      [address, company, JSON.stringify({ line1: "Synthetic" })],
    );
    for (const p of f.data.products)
      await f.pool.query(
        "INSERT INTO products(id,erp_product_reference,sku,name,selling_uom,minimum_order_quantity,active) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          p.id,
          p.erpProductReference,
          p.sku,
          p.name,
          p.sellingUom,
          p.minimumOrderQuantity,
          p.active,
        ],
      );
    for (const row of f.data.customer_product_access)
      await f.pool.query(
        "INSERT INTO customer_product_access(id,company_id,product_id,eligible) VALUES($1,$2,$3,$4)",
        [randomUUID(), row.companyId, row.productId, row.eligible],
      );
    const source = createMockCustomerCatalogSource(config),
      drafts = createOrderDrafts(
        createPostgresOrderDrafts(f.pool, f.now),
        f.record,
        { minimum: { amount: "27.5", currency: "AED" }, source },
      );
    let draft = (
      await drafts.create(
        customer,
        { deliveryAddressId: address },
        randomUUID(),
      )
    ).draft;
    draft = (
      await drafts.changeItem(
        customer,
        draft.id,
        undefined,
        "add",
        {
          version: draft.version,
          productId: f.data.products[0].id,
          quantity: "1",
        },
        randomUUID(),
      )
    ).draft;
    const quote = await drafts.terms(customer, draft.id, {
      version: draft.version,
    });
    draft = (
      await drafts.acknowledgeTerms(
        customer,
        draft.id,
        { version: draft.version, token: quote.token },
        randomUUID(),
      )
    ).draft;
    const waiting = barrier(),
      release = barrier(),
      adapter = createMockSubmissionAdapter(config);
    let attempts = 0;
    t.after(() => release.resolve());
    const gateway = createPostgresRetryingGateway(
      f.pool,
      {
        send: async (request) => {
          if (++attempts === 1)
            return { outcome: "rejected", code: "ERP_UNAVAILABLE" };
          return adapter.send(request);
        },
      },
      { maxRetries: 1, delayMs: 100 },
      async () => {
        waiting.resolve();
        await release.promise;
      },
    );
    const submit = createPostgresOrderSubmission(
        f.pool,
        source,
        { amount: "27.5", currency: "AED" },
        gateway,
      ),
      pending = submit(customer, draft.id, "monitor-real-producer", {
        version: draft.version,
      });
    await Promise.race([
      waiting.promise,
      pending.then(() => {
        throw Error("Submission completed before retained retry was inspected");
      }),
    ]);
    const before = await f.raw(),
      processing = await f.list({ orderId: draft.id }, a);
    assert.equal(processing.total, 1);
    assert.equal(processing.items[0].operation, "ORDER_SUBMISSION");
    assert.equal(processing.items[0].status, "PROCESSING");
    assert.equal(processing.items[0].retryCount, 1);
    assert.equal(processing.items[0].errorCode, "ERP_UNAVAILABLE");
    assert.ok(processing.items[0].nextRetryAt);
    assert.deepEqual(await f.raw(), before);
    release.resolve();
    await pending;
    const final = await f.find(processing.items[0].id, a);
    assert.equal(final.transaction.status, "SUCCESS");
    assert.equal(final.transaction.retryCount, 1);
    assert.equal(final.transaction.nextRetryAt, null);
    assert.equal(attempts, 2);
    const order = (
      await f.pool.query(
        "SELECT order_status,order_snapshot FROM orders WHERE id=$1",
        [draft.id],
      )
    ).rows[0];
    assert.equal(order.order_status, "SUBMITTED");
    assert.equal(order.order_snapshot.orderId, draft.id);
    assert.equal(
      JSON.stringify({ processing, final }).includes("monitor-real-producer"),
      false,
    );
  },
);

test("actual API runtime monitors PostgreSQL in production without ERP config and reports JSON capability unavailable", async (t) => {
  const { spawn } = await import("node:child_process"),
    { createServer } = await import("node:net");
  for (const provider of ["json", "postgresql"]) {
    if (
      provider === "postgresql" &&
      !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
    )
      continue;
    await t.test(provider, async (t) => {
      const f = await fixture(t, provider),
        token = (await f.login()).accessToken,
        probe = createServer();
      probe.listen(0, "127.0.0.1");
      await once(probe, "listening");
      const port = probe.address().port;
      await new Promise((r) => probe.close(r));
      let connection = "",
        pgOptions = "";
      if (provider === "postgresql") {
        const schema = (await f.pool.query("SELECT current_schema() AS name"))
            .rows[0].name,
          url = new URL(process.env.B2B_TEST_MIGRATIONS_DATABASE_URL);
        pgOptions = `-c search_path=${schema}`;
        connection = url.toString();
      }
      const env = {
        ...process.env,
        NODE_ENV: "production",
        API_HOST: "127.0.0.1",
        API_PORT: String(port),
        DATABASE_URL: connection,
        PGOPTIONS: pgOptions,
        JSON_DATA_DIR: f.directory,
        AUTH_JWT_ISSUER: "password-test",
        AUTH_JWT_AUDIENCE: "password-test",
        AUTH_JWT_ACTIVE_KID: "synthetic",
        AUTH_JWT_KEYS: JSON.stringify({
          synthetic: Buffer.alloc(32, 23).toString("base64url"),
        }),
      };
      for (const key of Object.keys(env))
        if (
          key.startsWith("ERP_") ||
          key.startsWith("DEMO_") ||
          key.startsWith("SUBMISSION_MINIMUM_") ||
          ["AUTH_ACCESS_TTL_SECONDS", "AUTH_REFRESH_TTL_SECONDS"].includes(key)
        )
          delete env[key];
      const child = spawn(process.execPath, ["apps/api/dist/index.js"], {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        timer;
      t.after(async () => {
        if (child.exitCode === null) {
          child.kill();
          await once(child, "exit");
        }
      });
      await new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(Error("Synthetic monitor API startup timeout")),
          5000,
        );
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("api.started")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(Error("Synthetic monitor API stopped before startup"));
        });
      });
      const response = await get(`http://127.0.0.1:${port}` + path, token);
      if (provider === "json") assert.equal(response.status, 503);
      else {
        const result = await data(response);
        assert.equal(result.total, 10);
        assert.equal(
          (
            await data(
              await get(`http://127.0.0.1:${port}` + path + "/" + id(0), token),
            )
          ).transaction.id,
          id(0),
        );
      }
      assert.equal(output.includes(f.passwordHash), false);
      assert.equal(output.includes("HIDDEN"), false);
    });
  }
});
