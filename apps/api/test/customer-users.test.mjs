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
import { createCustomerUsers } from "../dist/services/customer-users.js";
import { createJsonCustomerUsers } from "../dist/infrastructure/json/customer-users.js";
import { createPostgresCustomerUsers } from "../dist/infrastructure/postgres-customer-users.js";
import {
  hashPassword,
  verifyPassword,
} from "../dist/infrastructure/passwords.js";
import { JsonSecurityCoordinator } from "../dist/infrastructure/json/security.js";
import { createApp } from "../dist/app.js";
const body = (email = "managed@example.test") => ({
  displayName: " Managed person ",
  email,
  temporaryPassword: oldPassword,
});
const denied = (e) =>
  ["invalid_proof", "restricted", "forbidden"].includes(e.code) ||
  e.name === "AuthorizationError";
const unavailable = (e) => e.code === "unavailable",
  conflict = (e) => e.code === "conflict";
async function fixture(t, provider = "json", options = {}) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.repo =
    provider === "json"
      ? createJsonCustomerUsers(f.security, f.now, options)
      : createPostgresCustomerUsers(f.pool, f.now);
  f.service = (hash = async () => f.passwordHash, repo = f.repo) =>
    createCustomerUsers(repo, hash, f.record, randomUUID);
  f.manage = f.service();
  f.actor = async (i = 2) =>
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
  f.company = async (status) => {
    if (provider === "json")
      await f.security.store.replace(
        "companies",
        (await f.security.store.read("companies")).map((c) =>
          c.id === f.data.companies[0].id ? { ...c, status } : c,
        ),
      );
    else
      await f.pool.query("UPDATE companies SET status=$1 WHERE id=$2", [
        status,
        f.data.companies[0].id,
      ]);
  };
  f.role = async (role) => {
    if (provider === "json") await f.setUser({ role }, 2);
    else
      await f.pool.query("UPDATE users SET role=$1 WHERE id=$2", [
        role,
        f.data.users[2].id,
      ]);
  };
  return f;
}
async function serve(t, f, service = f.manage, logs = []) {
  const server = createApp({
    sessions: f.auth,
    customerUsers: service,
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
  return "http://127.0.0.1:" + server.address().port + "/api/v1/customer-users";
}
const post = (url, token, value, extra = {}) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...extra,
    },
    body: JSON.stringify(value),
  });
async function data(response, status = 200) {
  assert.equal(response.status, status);
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
      ": own Customer Admin creates a private temporary credential, first-login change works, and deactivation revokes proofs without deleting history",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        logs = [],
        url = await serve(t, f, f.service(hashPassword), logs);
      const a = (await f.login(2)).accessToken,
        b = (await f.login(4)).accessToken;
      const created = await data(
        await post(url, a, body("  Managed@Example.test ")),
        201,
      );
      assert.deepEqual(
        Object.keys(created.user).sort(),
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
      assert.equal(created.user.email, "managed@example.test");
      assert.equal(created.user.displayName, "Managed person");
      assert.equal(created.user.companyId, f.data.companies[0].id);
      assert.equal(created.user.role, "CUSTOMER_USER");
      assert.equal(created.user.status, "ACTIVE");
      assert.equal(created.user.mustChangePassword, true);
      const other = await data(
        await post(url, b, body("other-managed@example.test")),
        201,
      );
      assert.equal(other.user.companyId, f.data.companies[1].id);
      const stored = (await f.users()).find((u) => u.id === created.user.id),
        storedOther = (await f.users()).find((u) => u.id === other.user.id);
      assert.match(stored.passwordHash, /^scrypt-v1\$/);
      assert.notEqual(stored.passwordHash, storedOther.passwordHash);
      assert.equal(
        await verifyPassword(oldPassword, stored.passwordHash),
        true,
      );
      assert.equal(JSON.stringify(created).includes(oldPassword), false);
      assert.equal(
        JSON.stringify(created).includes(stored.passwordHash),
        false,
      );
      const login = await f.auth.login(
        { email: created.user.email, password: oldPassword },
        randomUUID(),
      );
      assert.equal(login.user.mustChangePassword, true);
      await assert.rejects(
        createAuthorization(f.auth.authenticateAccess).admit(
          login.accessToken,
          "orders.read",
        ),
        denied,
      );
      await f.change()(
        login.accessToken,
        { currentPassword: oldPassword, newPassword },
        randomUUID(),
      );
      await assert.rejects(
        f.auth.authenticateAccess(login.accessToken),
        denied,
      );
      const normal = await f.auth.login(
        { email: created.user.email, password: newPassword },
        randomUUID(),
      );
      assert.equal(
        (
          await createAuthorization(f.auth.authenticateAccess).admit(
            normal.accessToken,
            "orders.read",
          )
        ).mustChangePassword,
        false,
      );
      const order = {
        id: randomUUID(),
        companyId: created.user.companyId,
        createdByUserId: created.user.id,
        createdAt: new Date(f.now()).toISOString(),
        orderNumber: null,
        status: "DRAFT",
        integrationStatus: "NOT_SENT",
      };
      if (provider === "json")
        await f.security.store.replace("orders", [
          ...(await f.security.store.read("orders")),
          order,
        ]);
      else
        await f.pool.query(
          "INSERT INTO orders(id,company_id,created_by_user_id,created_at) VALUES($1,$2,$3,$4)",
          [order.id, order.companyId, order.createdByUserId, order.createdAt],
        );
      const before = (await f.users()).find((u) => u.id === created.user.id);
      const deactivated = await data(
        await post(url + "/" + created.user.id + "/deactivate", a, {
          expectedStatus: "ACTIVE",
        }),
      );
      assert.equal(deactivated.user.status, "DEACTIVATED");
      const after = (await f.users()).find((u) => u.id === created.user.id);
      assert.equal(after.passwordHash, before.passwordHash);
      assert.equal(after.mustChangePassword, false);
      await assert.rejects(
        f.auth.authenticateAccess(normal.accessToken),
        denied,
      );
      await assert.rejects(
        f.auth.refresh({ refreshToken: normal.refreshToken }, randomUUID()),
        denied,
      );
      await assert.rejects(
        f.auth.login(
          { email: created.user.email, password: newPassword },
          randomUUID(),
        ),
        (e) => e.code === "invalid_credentials",
      );
      const history =
        provider === "json"
          ? await f.security.store.read("orders")
          : (await f.pool.query("SELECT id FROM orders")).rows;
      assert.ok(history.some((o) => o.id === order.id));
      await f.auth.authenticateAccess(b);
      const audit =
        provider === "json"
          ? JSON.parse(
              await fs.readFile(join(f.directory, "audit_logs.json"), "utf8"),
            )
          : (await f.pool.query("SELECT action,metadata FROM audit_logs")).rows;
      assert.ok(audit.some((r) => r.action === "user.created"));
      assert.ok(audit.some((r) => r.action === "user.deactivated"));
      for (const text of [JSON.stringify(logs), JSON.stringify(audit)])
        for (const privateText of [
          oldPassword,
          newPassword,
          stored.passwordHash,
          "managed@example.test",
        ])
          assert.equal(text.includes(privateText), false);
    },
  );
  test(
    provider +
      ": role, company and target restrictions deny forged actors and foreign/ineligible targets uniformly",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        url = await serve(t, f),
        admin = (await f.login(2)).accessToken;
      for (const index of [0, 1, 3, 5])
        assert.equal(
          (await post(url, (await f.login(index)).accessToken, body())).status,
          403,
        );
      assert.equal((await post(url, undefined, body())).status, 401);
      const own = (await f.manage.create(await f.actor(), body(), randomUUID()))
        .user;
      const foreign = (await f.login(4)).accessToken;
      const responses = [];
      for (const id of [own.id, randomUUID(), f.data.users[4].id]) {
        const response = await post(url + "/" + id + "/deactivate", foreign, {
          expectedStatus: "ACTIVE",
        });
        assert.equal(response.status, 404);
        responses.push((await response.json()).error);
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.deepEqual(responses[1], responses[2]);
      for (const id of [
        f.data.users[2].id,
        f.data.users[0].id,
        f.data.users[1].id,
      ])
        assert.equal(
          (
            await post(url + "/" + id + "/deactivate", admin, {
              expectedStatus: "ACTIVE",
            })
          ).status,
          404,
        );
      await assert.rejects(
        f.manage.create(
          { role: "CUSTOMER_ADMIN", companyId: f.data.companies[0].id },
          body(),
          randomUUID(),
        ),
        denied,
      );
      await assert.rejects(
        f.manage.deactivate(
          { ...(await f.actor()) },
          own.id,
          { expectedStatus: "ACTIVE" },
          randomUUID(),
        ),
        denied,
      );
      assert.equal(
        (await f.users()).find((u) => u.id === own.id).status,
        "ACTIVE",
      );
    },
  );
  test(
    provider +
      ": validation rejects identity/status/hash selectors and malformed credentials before hashing or mutation",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        actor = await f.actor();
      let hashes = 0;
      const service = f.service(async () => {
        hashes++;
        return f.passwordHash;
      });
      for (const value of [
        null,
        [],
        {},
        { ...body(), role: "CUSTOMER_ADMIN" },
        { ...body(), companyId: f.data.companies[1].id },
        { ...body(), status: "ACTIVE" },
        { ...body(), passwordHash: f.passwordHash },
        { ...body(), id: randomUUID() },
        { ...body(), displayName: " " },
        { ...body(), displayName: "x".repeat(161) },
        { ...body(), displayName: "bad\u0000name" },
        { ...body(), email: "bad\u0001@example.test" },
        { ...body(), email: "not-email" },
        { ...body(), temporaryPassword: "" },
        { ...body(), temporaryPassword: "x".repeat(1025) },
      ])
        await assert.rejects(
          service.create(actor, value, randomUUID()),
          (e) => e.code === "invalid_input",
        );
      assert.equal(hashes, 0);
      assert.equal((await f.users()).length, f.data.users.length);
      for (const value of [
        { expectedStatus: "PENDING" },
        { expectedStatus: "DEACTIVATED" },
        { expectedStatus: "ACTIVE", status: "ACTIVE" },
        {},
      ])
        await assert.rejects(
          service.deactivate(actor, f.data.users[3].id, value, randomUUID()),
          (e) => e.code === "invalid_input",
        );
    },
  );
  test(
    provider +
      ": global duplicate creation and same-target deactivation each have one winner",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        a = await f.actor(),
        b = await f.actor(4);
      const results = await Promise.allSettled([
        f.manage.create(a, body(" DUP@example.test "), randomUUID()),
        f.manage.create(b, body("dup@example.test"), randomUUID()),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.filter((r) => r.status === "rejected" && conflict(r.reason))
          .length,
        1,
      );
      assert.equal(
        (await f.users()).filter((u) => u.email === "dup@example.test").length,
        1,
      );
      await assert.rejects(
        f.manage.create(a, body(f.data.users[5].email), randomUUID()),
        conflict,
      );
      const races = await Promise.allSettled([
        f.manage.deactivate(
          a,
          f.data.users[3].id,
          { expectedStatus: "ACTIVE" },
          randomUUID(),
        ),
        f.manage.deactivate(
          a,
          f.data.users[3].id,
          { expectedStatus: "ACTIVE" },
          randomUUID(),
        ),
      ]);
      assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        races.filter((r) => r.status === "rejected" && conflict(r.reason))
          .length,
        1,
      );
    },
  );
  test(
    provider +
      ": actor role, suspension, revocation and access expiry are rechecked after password work",
    opts,
    async (t) => {
      for (const scenario of [
        "role",
        "company",
        "suspended",
        "restricted",
        "credential",
        "revoked",
        "expired",
      ])
        await t.test(scenario, async (t) => {
          const f = await fixture(t, provider),
            actor = await f.actor(),
            entered = barrier(),
            release = barrier();
          const service = f.service(async () => {
            entered.resolve();
            await release.promise;
            return f.passwordHash;
          });
          const pending = service.create(actor, body(), randomUUID());
          await entered.promise;
          if (scenario === "role") await f.role("CUSTOMER_USER");
          else if (scenario === "company") await f.company("SUSPENDED");
          else if (scenario === "suspended")
            await f.setUser({ status: "SUSPENDED" }, 2);
          else if (scenario === "restricted")
            await f.setUser({ mustChangePassword: true }, 2);
          else if (scenario === "credential") {
            const hash = await hashPassword(newPassword);
            if (provider === "json") await f.setUser({ passwordHash: hash }, 2);
            else
              await f.pool.query(
                "UPDATE users SET password_hash=$1 WHERE id=$2",
                [hash, actor.userId],
              );
          } else if (scenario === "expired")
            f.clock.value = Date.parse(actor.accessExpiresAt);
          // Revoke the admitted session itself; another login must not be substituted.
          if (scenario === "revoked") {
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
          }
          release.resolve();
          await assert.rejects(pending, denied);
          assert.equal((await f.users()).length, f.data.users.length);
        });
    },
  );
  test(
    provider +
      ": required audit failure reports an unconfirmed committed result and never reactivates a deactivated user",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        actor = await f.actor();
      f.beforeAudit = async (event) => {
        if (event.action === "user.created") throw new Error("PRIVATE_AUDIT");
      };
      await assert.rejects(
        f.manage.create(actor, body(), randomUUID()),
        unavailable,
      );
      const row = (await f.users()).find(
        (u) => u.email === "managed@example.test",
      );
      assert.equal(row.mustChangePassword, true);
      f.beforeAudit = async () => {};
      const login = await f.auth.login(
        { email: row.email, password: oldPassword },
        randomUUID(),
      );
      f.beforeAudit = async (event) => {
        if (event.action === "user.deactivated")
          throw new Error("PRIVATE_AUDIT");
      };
      await assert.rejects(
        f.manage.deactivate(
          actor,
          row.id,
          { expectedStatus: "ACTIVE" },
          randomUUID(),
        ),
        unavailable,
      );
      assert.equal(
        (await f.users()).find((u) => u.id === row.id).status,
        "DEACTIVATED",
      );
      await assert.rejects(
        f.auth.authenticateAccess(login.accessToken),
        denied,
      );
    },
  );
}
test("JSON publication failures and session cleanup interruptions retain complete safe user state after reopen", async (t) => {
  for (const scenario of [
    "before-create",
    "after-create",
    "before-deactivate",
    "after-deactivate",
    "cleanup",
  ])
    await t.test(scenario, async (t) => {
      const f = await fixture(t),
        actor = await f.actor();
      const options = {
        writeUsers: async (rows) => {
          if (scenario.startsWith("before")) throw new Error("PRIVATE_BEFORE");
          await f.security.store.replace("users", rows);
          if (scenario.startsWith("after")) throw new Error("PRIVATE_AFTER");
        },
        io: {
          ...fs,
          rename: async (...args) => {
            if (scenario === "cleanup") throw new Error("PRIVATE_CLEANUP");
            return fs.rename(...args);
          },
        },
      };
      const repo = createJsonCustomerUsers(f.security, f.now, options),
        service = f.service(undefined, repo);
      const target = f.data.users[3],
        token = (await f.login(3)).accessToken;
      if (scenario.endsWith("create"))
        await assert.rejects(
          service.create(actor, body(), randomUUID()),
          unavailable,
        );
      else
        await assert.rejects(
          service.deactivate(
            actor,
            target.id,
            { expectedStatus: "ACTIVE" },
            randomUUID(),
          ),
          unavailable,
        );
      const reopened = new JsonSecurityCoordinator(f.directory),
        users = await reopened.store.read("users");
      if (scenario === "before-create")
        assert.equal(users.length, f.data.users.length);
      if (scenario === "after-create") {
        const created = users.find((u) => u.email === "managed@example.test");
        assert.ok(created);
        assert.equal(created.mustChangePassword, true);
        assert.ok(!JSON.stringify(created).includes(oldPassword));
      }
      if (scenario === "before-deactivate")
        await f.auth.authenticateAccess(token);
      if (["after-deactivate", "cleanup"].includes(scenario)) {
        assert.equal(
          users.find((u) => u.id === target.id).status,
          "DEACTIVATED",
        );
        await assert.rejects(f.auth.authenticateAccess(token), denied);
      }
    });
});
test("JSON new-user publication refuses an unresolved application intent without claiming its reserved email", async (t) => {
  const f = await fixture(t),
    actor = await f.actor(),
    before = await f.users();
  await fs.writeFile(join(f.directory, "application_intent.json"), "{}");
  await assert.rejects(
    f.manage.create(actor, body(), randomUUID()),
    unavailable,
  );
  assert.deepEqual(await f.users(), before);
});
test(
  "SQL insert/revocation failures roll back and connection failures are controlled",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, "postgresql"),
      actor = await f.actor(),
      target = f.data.users[3],
      login = await f.login(3);
    await f.pool.query(
      "CREATE FUNCTION refuse_managed_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_SQL_FAILURE'; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER refuse_insert BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION refuse_managed_user()",
    );
    await assert.rejects(
      f.manage.create(actor, body(), randomUUID()),
      unavailable,
    );
    assert.equal((await f.users()).length, f.data.users.length);
    await f.pool.query("DROP TRIGGER refuse_insert ON users");
    await f.pool.query(
      "CREATE TRIGGER refuse_revoke BEFORE UPDATE ON user_sessions FOR EACH ROW EXECUTE FUNCTION refuse_managed_user()",
    );
    await assert.rejects(
      f.manage.deactivate(
        actor,
        target.id,
        { expectedStatus: "ACTIVE" },
        randomUUID(),
      ),
      unavailable,
    );
    assert.equal(
      (await f.users()).find((u) => u.id === target.id).status,
      "ACTIVE",
    );
    await f.auth.authenticateAccess(login.accessToken);
    const broken = createPostgresCustomerUsers(
      {
        connect: async () => {
          throw new Error("PRIVATE_CONNECT");
        },
      },
      f.now,
    );
    await assert.rejects(
      f.service(undefined, broken).create(actor, body(), randomUUID()),
      unavailable,
    );
  },
);
test(
  "SQL access expiry after real account and unique-email lock waits rolls the new user back",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    for (const kind of ["actor-row", "email-index"])
      await t.test(kind, async (t) => {
        const f = await fixture(t, "postgresql"),
          actor = await f.actor(),
          entered = barrier(),
          blocker = await f.pool.connect();
        await blocker.query("BEGIN");
        if (kind === "actor-row")
          await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            actor.userId,
          ]);
        else
          await blocker.query(
            "INSERT INTO users(id,company_id,email,password_hash,display_name,role,status,must_change_password) VALUES($1,$2,$3,$4,'Blocking synthetic user','CUSTOMER_USER','ACTIVE',true)",
            [
              randomUUID(),
              actor.companyId,
              "managed@example.test",
              f.passwordHash,
            ],
          );
        const pool = {
          connect: async () => {
            const c = await f.pool.connect();
            return {
              on: c.on.bind(c),
              off: c.off.bind(c),
              release: c.release.bind(c),
              query: (...args) => {
                const pending = c.query(...args);
                if (
                  typeof args[0] === "string" &&
                  args[0].includes(
                    kind === "actor-row"
                      ? "ORDER BY id FOR UPDATE"
                      : "INSERT INTO users",
                  )
                )
                  entered.resolve();
                return pending;
              },
            };
          },
        };
        try {
          const service = f.service(
            undefined,
            createPostgresCustomerUsers(pool, f.now),
          );
          const pending = service.create(actor, body(), randomUUID());
          await entered.promise;
          f.clock.value = Date.parse(actor.accessExpiresAt);
          await blocker.query("ROLLBACK");
          await assert.rejects(pending, denied);
          assert.equal((await f.users()).length, f.data.users.length);
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
      });
  },
);
test("service rejects a mixed-company result before returning it or auditing it", async (t) => {
  const f = await fixture(t),
    actor = await f.actor();
  let audits = 0;
  f.beforeAudit = async () => {
    audits++;
  };
  const service = f.service(undefined, {
    create: async (_actor, input) => ({
      ...input,
      companyId: f.data.companies[1].id,
      role: "CUSTOMER_USER",
      status: "ACTIVE",
      mustChangePassword: true,
    }),
    deactivate: async () => assert.fail("Unexpected operation"),
  });
  await assert.rejects(
    service.create(actor, body(), randomUUID()),
    unavailable,
  );
  assert.equal(audits, 0);
});
test("HTTP management capacity is bounded and released after completion", async (t) => {
  const f = await fixture(t),
    entered = barrier(),
    release = barrier();
  let calls = 0;
  const user = {
    id: randomUUID(),
    companyId: f.data.companies[0].id,
    displayName: "Synthetic",
    email: "managed@example.test",
    role: "CUSTOMER_USER",
    status: "ACTIVE",
    mustChangePassword: true,
  };
  const url = await serve(t, f, {
    create: async () => {
      if (++calls === 4) entered.resolve();
      await release.promise;
      return { user };
    },
    deactivate: async () => assert.fail("Unexpected operation"),
  });
  t.after(() => release.resolve());
  const token = (await f.login(2)).accessToken,
    pending = Array.from({ length: 4 }, () => post(url, token, body()));
  await entered.promise;
  assert.equal((await post(url, token, body())).status, 503);
  release.resolve();
  for (const response of await Promise.all(pending))
    assert.equal(response.status, 201);
  assert.equal((await post(url, token, body())).status, 201);
});
test("HTTP management bounds parsing, queries and attempt rate without reflecting credentials", async (t) => {
  const f = await fixture(t),
    logs = [],
    url = await serve(t, f, f.manage, logs),
    token = (await f.login(2)).accessToken;
  assert.equal(
    (await post(url + "?companyId=" + f.data.companies[1].id, token, body()))
      .status,
    400,
  );
  assert.equal(
    (await post(url, token, body(), { "content-type": "text/plain" })).status,
    415,
  );
  assert.equal(
    (await post(url, token, { ...body(), temporaryPassword: "x".repeat(9000) }))
      .status,
    413,
  );
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(
    (await post(url, token, body(), { "content-encoding": "gzip" })).status,
    415,
  );
  for (let i = 0; i < 5; i++)
    assert.equal((await post(url, token, {})).status, 400);
  const limited = await post(url, token, {});
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.has("retry-after"));
  assert.equal(limited.headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(logs).includes(oldPassword), false);
});
