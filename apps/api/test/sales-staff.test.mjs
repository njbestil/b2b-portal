import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  authFixture,
  oldPassword,
  newPassword,
  barrier,
} from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createSalesStaff } from "../dist/services/sales-staff.js";
import { createJsonSalesStaff } from "../dist/infrastructure/json/sales-staff.js";
import { createPostgresSalesStaff } from "../dist/infrastructure/postgres-sales-staff.js";
import { createJsonSalesAssignments } from "../dist/infrastructure/json/sales-assignments.js";
import { createPostgresSalesAssignments } from "../dist/infrastructure/postgres-sales-assignments.js";
import { hashPassword } from "../dist/infrastructure/passwords.js";
import { createApp } from "../dist/app.js";
const body = (email = "sales@example.test") => ({
  displayName: " Synthetic Sales ",
  email,
  temporaryPassword: oldPassword,
});
const denied = (e) =>
  ["invalid_proof", "restricted", "forbidden", "invalid_credentials"].includes(
    e.code,
  ) || e.name === "AuthorizationError";
const code = (value) => (e) => e.code === value;
async function fixture(t, provider = "json", options = {}) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.repo =
    provider === "json"
      ? createJsonSalesStaff(f.security, f.now, options)
      : createPostgresSalesStaff(f.pool, f.now);
  f.service = (hash = async () => f.passwordHash, repo = f.repo) =>
    createSalesStaff(repo, hash, f.record, randomUUID);
  f.manage = f.service();
  f.actor = async (i = 0) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(i)).accessToken,
      "profile.read",
    );
  f.users = async () =>
    provider === "json"
      ? f.security.store.read("users")
      : (
          await f.pool.query(
            'SELECT id,company_id AS "companyId",email,password_hash AS "passwordHash",display_name AS "displayName",role,status,must_change_password AS "mustChangePassword" FROM users',
          )
        ).rows;
  f.assignments =
    provider === "json"
      ? createJsonSalesAssignments(f.security, f.now)
      : createPostgresSalesAssignments(f.pool, f.now);
  return f;
}
async function serve(t, f, service = f.manage, logs = []) {
  const server = createApp({
    sessions: f.auth,
    salesStaff: service,
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
  return (
    "http://127.0.0.1:" + server.address().port + "/api/v1/admin/sales-staff"
  );
}
const post = (url, token, value, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...headers,
    },
    body: JSON.stringify(value),
  });
async function data(r, status = 200) {
  assert.equal(r.status, status);
  assert.equal(r.headers.get("cache-control"), "no-store");
  return (await r.json()).data;
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
      ": administrator creates safe fixed-role staff, first-login works, status changes revoke proofs and preserve assignments",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        logs = [],
        url = await serve(t, f, f.service(hashPassword), logs),
        admin = (await f.login()).accessToken;
      const { user } = await data(
        await post(url, admin, body("  SALES@EXAMPLE.TEST ")),
        201,
      );
      assert.deepEqual(
        Object.keys(user).sort(),
        [
          "id",
          "companyId",
          "displayName",
          "email",
          "role",
          "status",
          "mustChangePassword",
        ].sort(),
      );
      assert.equal(user.companyId, null);
      assert.equal(user.role, "SALES_STAFF");
      assert.equal(user.status, "ACTIVE");
      assert.equal(user.mustChangePassword, true);
      assert.equal(user.email, "sales@example.test");
      assert.equal(user.displayName, "Synthetic Sales");
      const login = () =>
        f.auth.login(
          { email: user.email, password: oldPassword },
          randomUUID(),
        );
      const restricted = await login();
      await assert.rejects(
        createAuthorization(f.auth.authenticateAccess).admit(
          restricted.accessToken,
          "sales.companies.read",
        ),
        denied,
      );
      await f.change()(
        restricted.accessToken,
        { currentPassword: oldPassword, newPassword },
        randomUUID(),
      );
      await assert.rejects(
        f.auth.authenticateAccess(restricted.accessToken),
        denied,
      );
      const normal = await f.auth.login(
        { email: user.email, password: newPassword },
        randomUUID(),
      );
      const assignment = {
        id: randomUUID(),
        companyId: f.data.companies[0].id,
        salesStaffUserId: user.id,
        assignedByUserId: f.data.users[0].id,
        isPrimary: true,
        active: true,
        createdAt: new Date(f.now()).toISOString(),
        endedAt: null,
      };
      if (provider === "json")
        await fs.writeFile(
          join(f.directory, "customer_sales_assignments.json"),
          JSON.stringify([assignment]),
        );
      else
        await f.pool.query(
          "INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at) VALUES($1,$2,$3,$4,true,true,$5)",
          [
            assignment.id,
            assignment.companyId,
            user.id,
            assignment.assignedByUserId,
            assignment.createdAt,
          ],
        );
      assert.equal(
        await f.assignments.allows(user.id, assignment.companyId),
        true,
      );
      const before = (await f.users()).find((u) => u.id === user.id);
      assert.equal(
        (
          await data(
            await post(url + `/${user.id}/deactivate`, admin, {
              expectedStatus: "ACTIVE",
            }),
          )
        ).user.status,
        "DEACTIVATED",
      );
      await assert.rejects(
        f.auth.authenticateAccess(normal.accessToken),
        denied,
      );
      await assert.rejects(
        f.auth.refresh({ refreshToken: normal.refreshToken }, randomUUID()),
        denied,
      );
      assert.equal(
        await f.assignments.allows(user.id, assignment.companyId),
        false,
      );
      assert.equal(
        (
          await data(
            await post(url + `/${user.id}/activate`, admin, {
              expectedStatus: "DEACTIVATED",
            }),
          )
        ).user.status,
        "ACTIVE",
      );
      await assert.rejects(
        f.auth.authenticateAccess(normal.accessToken),
        denied,
      );
      const fresh = await f.auth.login(
        { email: user.email, password: newPassword },
        randomUUID(),
      );
      assert.equal(
        (
          await createAuthorization(f.auth.authenticateAccess).admit(
            fresh.accessToken,
            "sales.companies.read",
          )
        ).role,
        "SALES_STAFF",
      );
      assert.equal(
        await f.assignments.allows(user.id, assignment.companyId),
        true,
      );
      const after = (await f.users()).find((u) => u.id === user.id);
      assert.equal(before.passwordHash, after.passwordHash);
      assert.equal(after.mustChangePassword, false);
      const assignments =
        provider === "json"
          ? JSON.parse(
              await fs.readFile(
                join(f.directory, "customer_sales_assignments.json"),
              ),
            )
          : (await f.pool.query("SELECT id FROM customer_sales_assignments"))
              .rows;
      assert.equal(assignments.length, 1);
      assert.equal(
        (await f.rows()).filter(
          (r) => r.userId === user.id && r.revokedAt === null,
        ).length,
        1,
      );
      const events =
        provider === "json"
          ? JSON.parse(await fs.readFile(join(f.directory, "audit_logs.json")))
          : (await f.pool.query("SELECT action,metadata FROM audit_logs")).rows;
      assert.deepEqual(
        events
          .filter((e) => e.action.startsWith("sales_staff."))
          .map((e) => e.action),
        [
          "sales_staff.created",
          "sales_staff.deactivated",
          "sales_staff.activated",
        ],
      );
      const output = JSON.stringify({ user, logs, events });
      for (const privateValue of [oldPassword, newPassword, after.passwordHash])
        assert.equal(output.includes(privateValue), false);
      assert.equal(JSON.stringify(events).includes(user.email), false);
    },
  );
  test(
    provider +
      ": four-role denial, fixed input, target eligibility, uniqueness and concurrent lifecycle conflicts",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        a = await f.actor();
      for (const i of [1, 2, 3, 4, 5])
        await assert.rejects(
          f.manage.create(await f.actor(i), body(), randomUUID()),
          denied,
        );
      await assert.rejects(
        f.manage.create({ ...a }, body(), randomUUID()),
        denied,
      );
      for (const patch of [
        { role: "INTERNAL_ADMIN" },
        { companyId: randomUUID() },
        { status: "ACTIVE" },
        { displayName: "\u0000" },
        { email: "x" },
        { temporaryPassword: "" },
        { temporaryPassword: "x".repeat(1025) },
      ])
        await assert.rejects(
          f.manage.create(a, { ...body(), ...patch }, randomUUID()),
          code("invalid_input"),
        );
      for (const u of f.data.users)
        await assert.rejects(
          f.manage.create(a, body(u.email.toUpperCase()), randomUUID()),
          code("conflict"),
        );
      const race = await Promise.allSettled([
        f.manage.create(a, body(), randomUUID()),
        f.manage.create(a, body(), randomUUID()),
      ]);
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        race.find((r) => r.status === "rejected").reason.code,
        "conflict",
      );
      const id = race.find((r) => r.status === "fulfilled").value.user.id;
      for (const target of [
        f.data.users[0].id,
        f.data.users[2].id,
        randomUUID(),
      ])
        await assert.rejects(
          f.manage.change(
            a,
            target,
            { expectedStatus: "ACTIVE" },
            "DEACTIVATED",
            randomUUID(),
          ),
          code("not_found"),
        );
      for (const [expected, next] of [
        ["PENDING", "ACTIVE"],
        ["ACTIVE", "ACTIVE"],
        ["DEACTIVATED", "DEACTIVATED"],
      ])
        await assert.rejects(
          f.manage.change(
            a,
            id,
            { expectedStatus: expected },
            next,
            randomUUID(),
          ),
          code("invalid_input"),
        );
      for (const [expected, next] of [
        ["ACTIVE", "DEACTIVATED"],
        ["DEACTIVATED", "ACTIVE"],
      ]) {
        const result = await Promise.allSettled([
          f.manage.change(
            a,
            id,
            { expectedStatus: expected },
            next,
            randomUUID(),
          ),
          f.manage.change(
            a,
            id,
            { expectedStatus: expected },
            next,
            randomUUID(),
          ),
        ]);
        assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(
          result.find((r) => r.status === "rejected").reason.code,
          "conflict",
        );
      }
      assert.equal(
        (await f.users()).find((u) => u.id === id).mustChangePassword,
        true,
      );
    },
  );
  test(
    provider +
      ": mutation rechecks administrator after hash wait and fails privately on audit/hash/storage errors",
    opts,
    async (t) => {
      for (const change of [
        "status",
        "role",
        "restricted",
        "logout",
        "expiry",
      ]) {
        const f = await fixture(t, provider),
          a = await f.actor(),
          started = barrier(),
          release = barrier();
        const pending = f
          .service(async () => {
            started.resolve();
            await release.promise;
            return f.passwordHash;
          })
          .create(a, body(), randomUUID());
        await started.promise;
        if (change === "status") await f.setUser({ status: "SUSPENDED" });
        if (change === "role") {
          if (provider === "json") await f.setUser({ role: "SALES_STAFF" });
          else
            await f.pool.query(
              "UPDATE users SET role='SALES_STAFF' WHERE id=$1",
              [a.userId],
            );
        }
        if (change === "restricted")
          await f.setUser({ mustChangePassword: true });
        if (change === "logout") await f.sessions.revoke(a.sessionId, a.userId);
        if (change === "expiry") f.clock.value = Date.parse(a.accessExpiresAt);
        release.resolve();
        await assert.rejects(pending, denied);
        assert.equal(
          (await f.users()).some((u) => u.email === "sales@example.test"),
          false,
        );
      }
      const f = await fixture(t, provider),
        a = await f.actor();
      await assert.rejects(
        f
          .service(async () => {
            throw Error("PRIVATE_HASH");
          })
          .create(a, body(), randomUUID()),
        code("unavailable"),
      );
      f.beforeAudit = async (input) => {
        if (input.action === "sales_staff.created")
          throw Error("PRIVATE_AUDIT");
      };
      await assert.rejects(
        f.manage.create(a, body(), randomUUID()),
        code("unavailable"),
      );
      assert.equal(
        (await f.users()).some((u) => u.email === "sales@example.test"),
        true,
      );
      const logs = [],
        url = await serve(
          t,
          f,
          f.service(undefined, {
            create: async () => {
              throw Error("PRIVATE_STORAGE");
            },
          }),
          logs,
        );
      const response = await post(
        url,
        (await f.login()).accessToken,
        body("next@example.test"),
      );
      assert.equal(response.status, 503);
      assert.equal((await response.text()).includes("PRIVATE"), false);
      assert.equal(JSON.stringify(logs).includes("PRIVATE"), false);
    },
  );
}

test("JSON interrupted cleanup cannot revive proofs on activation, publication failures and pending intent fail safely", async (t) => {
  for (const scenario of [
    "cleanup-deactivate",
    "cleanup-activate",
    "write-deactivate",
    "write-activate",
    "intent",
  ]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t),
        a = await f.actor(),
        id = f.data.users[1].id,
        login = await f.login(1);
      if (scenario.endsWith("activate") && !scenario.endsWith("deactivate"))
        await f.manage.change(
          a,
          id,
          { expectedStatus: "ACTIVE" },
          "DEACTIVATED",
          randomUUID(),
        );
      if (scenario === "intent")
        await fs.writeFile(join(f.directory, "application_intent.json"), "{}");
      const repo = createJsonSalesStaff(f.security, f.now, {
        io: {
          ...fs,
          rename: async (...args) => {
            if (scenario.startsWith("cleanup")) throw Error("PRIVATE_CLEANUP");
            return fs.rename(...args);
          },
        },
        writeUsers: async (rows) => {
          if (scenario.startsWith("write")) throw Error("PRIVATE_WRITE");
          await f.security.store.replace("users", rows);
        },
      });
      const service = f.service(undefined, repo),
        activate =
          scenario.endsWith("activate") && !scenario.endsWith("deactivate");
      if (scenario === "intent")
        await assert.rejects(
          service.create(a, body(), randomUUID()),
          code("unavailable"),
        );
      else
        await assert.rejects(
          service.change(
            a,
            id,
            { expectedStatus: activate ? "DEACTIVATED" : "ACTIVE" },
            activate ? "ACTIVE" : "DEACTIVATED",
            randomUUID(),
          ),
          code("unavailable"),
        );
      const status = (await f.users()).find((u) => u.id === id).status;
      assert.equal(
        status,
        scenario === "write-deactivate" || scenario === "intent"
          ? "ACTIVE"
          : "DEACTIVATED",
      );
      if (status === "DEACTIVATED")
        await assert.rejects(
          f.auth.authenticateAccess(login.accessToken),
          denied,
        );
      if (scenario === "cleanup-deactivate") {
        // Reopen using a fresh coordinator before activation to simulate a process restart.
        const { JsonSecurityCoordinator } =
          await import("../dist/infrastructure/json/security.js");
        const reopened = createJsonSalesStaff(
          new JsonSecurityCoordinator(f.directory),
          f.now,
        );
        await f
          .service(undefined, reopened)
          .change(
            a,
            id,
            { expectedStatus: "DEACTIVATED" },
            "ACTIVE",
            randomUUID(),
          );
        await assert.rejects(
          f.auth.authenticateAccess(login.accessToken),
          denied,
        );
        assert.equal(
          (await f.rows()).filter(
            (r) => r.userId === id && r.revokedAt === null,
          ).length,
          0,
        );
      }
    });
  }
});

test("HTTP enforces admission, JSON shape/media/size/query bounds, no-store and rate/in-flight limits", async (t) => {
  const f = await fixture(t),
    logs = [],
    url = await serve(t, f, f.manage, logs),
    admin = (await f.login()).accessToken;
  assert.equal((await post(url, null, body())).status, 401);
  for (const i of [1, 2, 3])
    assert.equal(
      (
        await post(url, (await f.login(i)).accessToken, body(), {
          "x-role": "INTERNAL_ADMIN",
        })
      ).status,
      403,
    );
  for (const [suffix, value, status] of [
    ["?companyId=x", body(), 400],
    ["", { ...body(), role: "SALES_STAFF" }, 400],
    ["/bad/activate", { expectedStatus: "DEACTIVATED" }, 400],
  ])
    assert.equal((await post(url + suffix, admin, value)).status, status);
  assert.equal(
    (await post(url, admin, body(), { "content-type": "text/plain" })).status,
    415,
  );
  assert.equal(
    (await post(url, admin, { ...body(), displayName: "x".repeat(9000) }))
      .status,
    413,
  );
  const malformed = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + admin,
      "content-type": "application/json",
    },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  let last;
  for (let i = 0; i < 6; i++) last = await post(url, admin, {});
  assert.equal(last.status, 429);
  assert.equal(last.headers.get("retry-after"), "60");
  const start = barrier(),
    release = barrier();
  let admitted = 0;
  const blocked = await serve(
    t,
    f,
    f.service(async () => {
      if (++admitted === 4) start.resolve();
      await release.promise;
      return f.passwordHash;
    }),
  );
  const pending = Array.from({ length: 4 }, (_, i) =>
    post(blocked, admin, body(`parallel${i}@example.test`)),
  );
  await start.promise;
  assert.equal(
    (await post(blocked, admin, body("overload@example.test"))).status,
    503,
  );
  release.resolve();
  assert.deepEqual(
    (await Promise.all(pending)).map((r) => r.status),
    [201, 201, 201, 201],
  );
  const text = JSON.stringify(logs);
  assert.equal(text.includes(oldPassword), false);
  assert.equal(text.includes("sales@example.test"), false);
});

test(
  "SQL expiry after real row/index waits and trigger failures roll back account/session changes",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    for (const kind of ["actor-row", "email-index"])
      await t.test(kind, async (t) => {
        const f = await fixture(t, "postgresql"),
          actor = await f.actor(),
          blocker = await f.pool.connect();
        await blocker.query("BEGIN");
        if (kind === "actor-row")
          await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            actor.userId,
          ]);
        else
          await blocker.query(
            "INSERT INTO users(id,email,password_hash,display_name,role,status,must_change_password) VALUES($1,$2,$3,'Blocking synthetic staff','SALES_STAFF','ACTIVE',true)",
            [randomUUID(), "sales@example.test", f.passwordHash],
          );
        const pending = f.manage.create(actor, body(), randomUUID());
        try {
          // Observe an actual PostgreSQL lock wait, not merely a scheduled promise.
          let waiting = false;
          for (let i = 0; i < 100; i++) {
            const row = await f.admin.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%users%'",
            );
            if (row.rows[0].n > 0) {
              waiting = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.equal(waiting, true);
          f.clock.value = Date.parse(actor.accessExpiresAt);
          await blocker.query("ROLLBACK");
          await assert.rejects(pending, denied);
          assert.equal(
            (await f.users()).some((u) => u.email === "sales@example.test"),
            false,
          );
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
      });
    const f = await fixture(t, "postgresql"),
      a = await f.actor(),
      id = f.data.users[1].id,
      login = await f.login(1);
    await f.pool.query(
      "CREATE FUNCTION refuse_session_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_SQL_FAILURE'; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER refuse_session_change BEFORE UPDATE ON user_sessions FOR EACH ROW EXECUTE FUNCTION refuse_session_change()",
    );
    await assert.rejects(
      f.manage.change(
        a,
        id,
        { expectedStatus: "ACTIVE" },
        "DEACTIVATED",
        randomUUID(),
      ),
      code("unavailable"),
    );
    assert.equal((await f.users()).find((u) => u.id === id).status, "ACTIVE");
    assert.equal(
      (await f.auth.authenticateAccess(login.accessToken)).role,
      "SALES_STAFF",
    );
  },
);
for (const provider of ["json", "postgresql"]) {
  test(
    provider +
      ": temporary restrictions survive activation, suspended transitions and lifecycle audit failures are explicit",
    {
      skip:
        provider === "postgresql" &&
        !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
    },
    async (t) => {
      const f = await fixture(t, provider),
        a = await f.actor();
      const { user } = await f.manage.create(a, body(), randomUUID());
      const proof = await f.auth.login(
        { email: user.email, password: oldPassword },
        randomUUID(),
      );
      f.beforeAudit = async (e) => {
        if (e.action === "sales_staff.deactivated")
          throw Error("PRIVATE_AUDIT");
      };
      await assert.rejects(
        f.manage.change(
          a,
          user.id,
          { expectedStatus: "ACTIVE" },
          "DEACTIVATED",
          randomUUID(),
        ),
        code("unavailable"),
      );
      assert.equal(
        (await f.users()).find((u) => u.id === user.id).status,
        "DEACTIVATED",
      );
      await assert.rejects(
        f.auth.authenticateAccess(proof.accessToken),
        denied,
      );
      f.beforeAudit = async (e) => {
        if (e.action === "sales_staff.activated") throw Error("PRIVATE_AUDIT");
      };
      await assert.rejects(
        f.manage.change(
          a,
          user.id,
          { expectedStatus: "DEACTIVATED" },
          "ACTIVE",
          randomUUID(),
        ),
        code("unavailable"),
      );
      const row = (await f.users()).find((u) => u.id === user.id);
      assert.equal(row.status, "ACTIVE");
      assert.equal(row.mustChangePassword, true);
      assert.equal(row.passwordHash, f.passwordHash);
      await assert.rejects(
        f.auth.authenticateAccess(proof.accessToken),
        denied,
      );
      const fresh = await f.auth.login(
        { email: user.email, password: oldPassword },
        randomUUID(),
      );
      await assert.rejects(
        createAuthorization(f.auth.authenticateAccess).admit(
          fresh.accessToken,
          "sales.companies.read",
        ),
        denied,
      );
      f.beforeAudit = async () => {};
      for (const next of ["ACTIVE", "DEACTIVATED"]) {
        if (provider === "json")
          await f.security.run(async () =>
            f.security.store.replace(
              "users",
              (await f.users()).map((u) =>
                u.id === user.id ? { ...u, status: "SUSPENDED" } : u,
              ),
            ),
          );
        else
          await f.pool.query(
            "UPDATE users SET status='SUSPENDED' WHERE id=$1",
            [user.id],
          );
        assert.equal(
          (
            await f.manage.change(
              a,
              user.id,
              { expectedStatus: "SUSPENDED" },
              next,
              randomUUID(),
            )
          ).user.status,
          next,
        );
      }
    },
  );
}
