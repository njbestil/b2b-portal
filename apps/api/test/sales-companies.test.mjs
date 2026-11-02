import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import test from "node:test";
import { authFixture, barrier } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createSalesCompanies } from "../dist/services/sales-companies.js";
import { createJsonSalesAssignments } from "../dist/infrastructure/json/sales-assignments.js";
import { createPostgresSalesAssignments } from "../dist/infrastructure/postgres-sales-assignments.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createApp } from "../dist/app.js";
const denied = (e) =>
  ["forbidden", "invalid_proof", "restricted"].includes(e.code) ||
  e.name === "AuthorizationError";
async function fixture(t, provider = "json") {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  const second = {
    ...f.data.users[1],
    id: randomUUID(),
    email: "second-sales@example.test",
    displayName: "Other synthetic sales",
    mustChangePassword: false,
  };
  f.second = f.data.users.length;
  f.data.users.push(second);
  f.data.companies[0].legalName = "Identical company name";
  const extra = [
    {
      ...f.data.companies[0],
      id: "f0000000-0000-4000-8000-000000000003",
      erpCustomerReference: "SYN-003",
    },
    {
      ...f.data.companies[0],
      id: "f0000000-0000-4000-8000-000000000004",
      erpCustomerReference: "SYN-004",
    },
  ];
  f.data.companies.push(...extra);
  if (provider === "json") {
    await f.security.store.replace("users", [
      ...(await f.security.store.read("users")),
      second,
    ]);
    await f.security.store.replace("companies", f.data.companies);
  } else {
    await f.pool.query(
      "INSERT INTO users(id,email,password_hash,display_name,role,status,must_change_password) VALUES($1,$2,$3,$4,'SALES_STAFF','ACTIVE',false)",
      [second.id, second.email, f.passwordHash, second.displayName],
    );
    for (const [i, c] of f.data.companies.entries()) {
      if (i < 2)
        await f.pool.query(
          "UPDATE companies SET legal_name=$1,erp_customer_reference=$2 WHERE id=$3",
          [c.legalName, c.erpCustomerReference, c.id],
        );
      else
        await f.pool.query(
          "INSERT INTO companies(id,legal_name,trade_name,status,erp_customer_reference) VALUES($1,$2,$3,$4,$5)",
          [c.id, c.legalName, c.tradeName, c.status, c.erpCustomerReference],
        );
    }
  }
  f.repo =
    provider === "json"
      ? createJsonSalesAssignments(f.security, f.now)
      : createPostgresSalesAssignments(f.pool, f.now);
  f.list = createSalesCompanies(f.repo);
  f.actor = async (index = 1) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(index)).accessToken,
      "profile.read",
    );
  f.assignment = (
    company = f.data.companies[0].id,
    staff = f.data.users[1].id,
    patch = {},
  ) => ({
    id: randomUUID(),
    companyId: company,
    salesStaffUserId: staff,
    assignedByUserId: f.data.users[0].id,
    isPrimary: true,
    active: true,
    createdAt: new Date(f.now() - 1000).toISOString(),
    endedAt: null,
    ...patch,
  });
  f.write = async (rows) => {
    if (provider === "json")
      await f.security.run(() =>
        fs.writeFile(
          join(f.directory, "customer_sales_assignments.json"),
          JSON.stringify(rows),
        ),
      );
    else {
      const c = await f.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("DELETE FROM customer_sales_assignments");
        for (const r of rows)
          await c.query(
            "INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              r.id,
              r.companyId,
              r.salesStaffUserId,
              r.assignedByUserId,
              r.isPrimary,
              r.active,
              r.createdAt,
              r.endedAt,
            ],
          );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
  };
  f.company = async (index, status) => {
    const id = f.data.companies[index].id;
    if (provider === "json")
      await f.security.store.replace(
        "companies",
        (await f.security.store.read("companies")).map((c) =>
          c.id === id ? { ...c, status } : c,
        ),
      );
    else
      await f.pool.query("UPDATE companies SET status=$1 WHERE id=$2", [
        status,
        id,
      ]);
  };
  f.role = async (role) => {
    if (provider === "json") await f.setUser({ role }, 1);
    else
      await f.pool.query("UPDATE users SET role=$1 WHERE id=$2", [
        role,
        f.data.users[1].id,
      ]);
  };
  f.repositories =
    provider === "json"
      ? createJsonRepositories(f.security.store)
      : createPostgresRepositories(f.pool);
  await f.write([
    f.assignment(),
    f.assignment(f.data.companies[1].id, second.id),
    f.assignment(extra[0].id),
  ]);
  return f;
}
async function serve(t, f, repo = f.repo, logs = []) {
  const server = createApp({
    sessions: f.auth,
    salesAssignments: repo,
    companyRepositories: f.repositories,
    logger: (level, event) => logs.push({ level, event }),
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  return "http://127.0.0.1:" + server.address().port;
}
const get = (url, token, headers = {}) =>
  fetch(url, {
    headers: {
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...headers,
    },
  });
async function data(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()).data;
}
for (const provider of ["json", "postgresql"]) {
  const opts = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
  };
  test(
    provider +
      ": Sales sees only active assigned companies with correct totals, stable pages and explicit public fields",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        logs = [],
        origin = await serve(t, f, f.repo, logs),
        url = origin + "/api/v1/sales/companies";
      const first = (await f.login(1)).accessToken,
        second = (await f.login(f.second)).accessToken;
      const expected = [f.data.companies[0].id, f.data.companies[2].id];
      const page = await data(await get(url, first));
      assert.deepEqual(
        page.items.map((c) => c.id),
        expected,
      );
      assert.equal(page.total, 2);
      assert.equal(page.offset, 0);
      assert.equal(page.limit, 20);
      for (const company of page.items)
        assert.deepEqual(
          Object.keys(company).sort(),
          [
            "id",
            "legalName",
            "tradeName",
            "status",
            "erpCustomerReference",
          ].sort(),
        );
      assert.ok(page.items.every((c) => c.status === "ACTIVE"));
      assert.equal(page.items[0].legalName, page.items[1].legalName);
      const p = await data(await get(url + "?offset=1&limit=1", first));
      assert.equal(p.total, 2);
      assert.deepEqual(
        p.items.map((c) => c.id),
        [expected[1]],
      );
      assert.deepEqual(
        (await data(await get(url, second))).items.map((c) => c.id),
        [f.data.companies[1].id],
      );
      for (const offset of [2, 100000]) {
        const end = await data(
          await get(url + "?offset=" + offset + "&limit=100", first),
        );
        assert.equal(end.total, 2);
        assert.deepEqual(end.items, []);
      }
      assert.deepEqual(
        await data(
          await get(url, first, {
            "x-company-id": f.data.companies[1].id,
            "x-role": "INTERNAL_ADMIN",
            "x-user-id": f.data.users[f.second].id,
          }),
        ),
        page,
      );
      assert.equal(
        (await get(origin + "/api/v1/companies/" + expected[0], first)).status,
        403,
      );
      for (const privateText of [
        f.passwordHash,
        "credentialFingerprint",
        "refreshTokenHash",
        f.data.users[1].email,
      ]) {
        assert.equal(JSON.stringify(page).includes(privateText), false);
        assert.equal(JSON.stringify(logs).includes(privateText), false);
      }
    },
  );
  test(
    provider +
      ": unassigned/ended/future/nonprimary and suspended companies never inflate results or counts; reassignment applies immediately",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        actor = await f.actor(),
        other = await f.actor(f.second),
        a = f.data.companies[0].id,
        b = f.data.companies[1].id;
      for (const patch of [
        { active: false, endedAt: new Date(f.now()).toISOString() },
        { createdAt: new Date(f.now() + 60000).toISOString() },
        { isPrimary: false },
      ]) {
        await f.write([
          f.assignment(a, actor.userId, patch),
          f.assignment(b, other.userId),
        ]);
        assert.deepEqual(await f.list(actor), {
          items: [],
          total: 0,
          offset: 0,
          limit: 20,
        });
        assert.equal((await f.list(other)).total, 1);
      }
      await f.write([
        f.assignment(a, actor.userId),
        f.assignment(b, other.userId),
      ]);
      await f.company(0, "SUSPENDED");
      assert.equal((await f.list(actor)).total, 0);
      assert.equal((await f.list(other)).total, 1);
      await f.company(0, "ACTIVE");
      assert.equal((await f.list(actor)).total, 1);
      await f.write([
        f.assignment(a, actor.userId, {
          active: false,
          endedAt: new Date(f.now()).toISOString(),
        }),
        f.assignment(a, other.userId),
        f.assignment(b, other.userId),
      ]);
      assert.equal((await f.list(actor)).total, 0);
      assert.equal((await f.list(other)).total, 2);
    },
  );
  test(
    provider +
      ": only a normal actual Sales actor can list; stale role/flag/lifecycle/credential/session proofs deny",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        origin = await serve(t, f),
        url = origin + "/api/v1/sales/companies";
      assert.equal((await get(url)).status, 401);
      for (const i of [0, 2, 3, 4, 5])
        assert.equal(
          (await get(url, (await f.login(i)).accessToken)).status,
          403,
        );
      await assert.rejects(
        f.list({ role: "SALES_STAFF", userId: f.data.users[1].id }),
        denied,
      );
      const actor = await f.actor();
      await assert.rejects(f.list({ ...actor }), denied);
      await f.role("INTERNAL_ADMIN");
      await assert.rejects(f.list(actor), denied);
      await f.role("SALES_STAFF");
      await f.setUser({ mustChangePassword: true }, 1);
      await assert.rejects(f.list(actor), denied);
      await f.setUser({ mustChangePassword: false, status: "SUSPENDED" }, 1);
      await assert.rejects(f.list(actor), denied);
      await f.setUser({ status: "ACTIVE" }, 1);
      const hash = "scrypt-v1$" + "a".repeat(32) + "$" + "b".repeat(64);
      if (provider === "json") await f.setUser({ passwordHash: hash }, 1);
      else
        await f.pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
          hash,
          actor.userId,
        ]);
      await assert.rejects(f.list(actor), denied);
      if (provider === "json")
        await f.setUser({ passwordHash: f.passwordHash }, 1);
      else
        await f.pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
          f.passwordHash,
          actor.userId,
        ]);
      if (provider === "json") {
        const path = join(f.directory, "user_sessions.json"),
          rows = JSON.parse(await fs.readFile(path, "utf8"));
        await fs.writeFile(
          path,
          JSON.stringify(
            rows.map((r) =>
              r.id === actor.sessionId
                ? { ...r, revokedAt: new Date(f.now()).toISOString() }
                : r,
            ),
          ),
        );
      } else
        await f.pool.query(
          "UPDATE user_sessions SET revoked_at=$1 WHERE id=$2",
          [new Date(f.now()).toISOString(), actor.sessionId],
        );
      await assert.rejects(f.list(actor), denied);
    },
  );
  test(
    provider +
      ": invalid selectors and page bounds reject before assignment I/O; unavailable storage never falls back",
    opts,
    async (t) => {
      const f = await fixture(t, provider);
      let calls = 0;
      const bad = {
        ...f.repo,
        listAssigned: async () => {
          calls++;
          throw new Error("PRIVATE_STORAGE");
        },
      };
      const origin = await serve(t, f, bad),
        token = (await f.login(1)).accessToken,
        url = origin + "/api/v1/sales/companies";
      for (const query of [
        "staffId=" + f.data.users[f.second].id,
        "companyId=" + f.data.companies[1].id,
        "role=INTERNAL_ADMIN",
        "offset=-1",
        "offset=01",
        "offset=1.5",
        "offset=100001",
        "offset=9007199254740992",
        "limit=0",
        "limit=101",
        "limit=1&limit=2",
        "offset[x]=1",
        "search=company",
      ]) {
        const response = await get(url + "?" + query, token);
        assert.equal(response.status, 400, query);
        assert.equal(
          (await response.json()).error.code,
          "INVALID_SALES_COMPANY_QUERY",
        );
      }
      assert.equal(calls, 0);
      const failed = await get(url, token);
      assert.equal(failed.status, 503);
      assert.equal(
        (await failed.json()).error.code,
        "SALES_COMPANIES_UNAVAILABLE",
      );
      assert.equal(calls, 1);
      const actor = await f.actor();
      for (const page of [
        { offset: 100001, limit: 1 },
        { offset: 0, limit: 0 },
        { offset: 1.5, limit: 10 },
      ])
        await assert.rejects(
          createSalesCompanies(bad)(actor, page),
          (e) => e.code === "invalid_input",
        );
      assert.equal(calls, 1);
    },
  );
  test(
    provider +
      ": ambiguous active primary assignments fail closed before count/pagination",
    opts,
    async (t) => {
      for (const scenario of ["primary", "pair"])
        await t.test(scenario, async (t) => {
          const f = await fixture(t, provider),
            actor = await f.actor();
          if (provider === "postgresql")
            await f.pool.query(
              scenario === "primary"
                ? "DROP INDEX assignments_one_active_primary_idx"
                : "DROP INDEX assignments_active_pair_idx",
            );
          await f.write([
            f.assignment(),
            f.assignment(
              f.data.companies[0].id,
              scenario === "primary" ? f.data.users[f.second].id : actor.userId,
              { isPrimary: scenario === "primary" },
            ),
          ]);
          await assert.rejects(
            f.list(actor, { offset: 100000, limit: 1 }),
            (e) => e.code === "unavailable",
          );
        });
    },
  );
}
test("JSON missing assignment file means no grants; corrupt/oversized source and incomplete session data are unavailable or denied", async (t) => {
  const f = await fixture(t),
    actor = await f.actor(),
    path = join(f.directory, "customer_sales_assignments.json");
  await fs.unlink(path);
  assert.equal((await f.list(actor)).total, 0);
  for (const value of [
    "not-json",
    "{}",
    Buffer.from([0xff]),
    " ".repeat(2 * 1024 * 1024 + 1),
  ]) {
    await fs.writeFile(path, value);
    await assert.rejects(f.list(actor), (e) => e.code === "unavailable");
  }
  await f.write([f.assignment()]);
  await fs.writeFile(join(f.directory, "user_sessions.json"), "[]");
  await assert.rejects(f.list(actor), denied);
});
test("JSON listing samples proof expiry after the real shared-coordinator wait", async (t) => {
  const f = await fixture(t),
    actor = await f.actor(),
    entered = barrier(),
    release = barrier();
  const hold = f.security.run(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const pending = f.list(actor);
  f.clock.value = Date.parse(actor.accessExpiresAt);
  release.resolve();
  await hold;
  await assert.rejects(pending, denied);
});
test(
  "SQL current assignments and access expiry are rechecked after actual pool acquisition wait",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    for (const scenario of ["unassigned", "expired"])
      await t.test(scenario, async (t) => {
        const f = await fixture(t, "postgresql"),
          actor = await f.actor();
        const pool = new Pool({
          connectionString: process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
          options: f.pool.options.options,
          max: 1,
        });
        t.after(() => pool.end());
        const held = await pool.connect();
        let released = false;
        try {
          const listing = createSalesCompanies(
            createPostgresSalesAssignments(pool, f.now),
          );
          const pending = listing(actor);
          const deadline = Date.now() + 2000;
          while (pool.waitingCount !== 1 && Date.now() < deadline)
            await delay(5);
          assert.equal(pool.waitingCount, 1);
          if (scenario === "unassigned") await f.write([]);
          else f.clock.value = Date.parse(actor.accessExpiresAt);
          held.release();
          released = true;
          if (scenario === "unassigned") assert.equal((await pending).total, 0);
          else await assert.rejects(pending, denied);
        } finally {
          if (!released) held.release();
        }
      });
  },
);
test(
  "actual SQL assignment-table loss returns a controlled unavailable response without another provider",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, "postgresql"),
      origin = await serve(t, f),
      token = (await f.login(1)).accessToken;
    await f.pool.query("DROP TABLE customer_sales_assignments");
    const response = await get(origin + "/api/v1/sales/companies", token);
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error.code, "SALES_COMPANIES_UNAVAILABLE");
    assert.equal(
      JSON.stringify(payload).includes("customer_sales_assignments"),
      false,
    );
    assert.equal(payload.data, undefined);
  },
);
test("public service rejects malformed/duplicate/nonactive results and strips private columns", async (t) => {
  const f = await fixture(t),
    actor = await f.actor(),
    company = f.data.companies[0];
  for (const result of [
    { items: [company, company], total: 2 },
    { items: [{ ...company, status: "SUSPENDED" }], total: 1 },
    { items: [], total: -1 },
    { items: [{ ...company, id: "bad" }], total: 1 },
  ])
    await assert.rejects(
      createSalesCompanies({ ...f.repo, listAssigned: async () => result })(
        actor,
      ),
      (e) => e.code === "unavailable",
    );
  const page = await createSalesCompanies({
    ...f.repo,
    listAssigned: async () => ({
      items: [
        {
          ...company,
          passwordHash: "PRIVATE",
          application: { secret: "PRIVATE" },
        },
      ],
      total: 1,
    }),
  })(actor);
  assert.equal(JSON.stringify(page).includes("PRIVATE"), false);
});
