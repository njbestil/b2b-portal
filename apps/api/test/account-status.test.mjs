import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { authFixture, barrier } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createAccountStatus } from "../dist/services/account-status.js";
import { createJsonAccountStatus } from "../dist/infrastructure/json/account-status.js";
import { createPostgresAccountStatus } from "../dist/infrastructure/postgres-account-status.js";
import { JsonSecurityCoordinator } from "../dist/infrastructure/json/security.js";
import { createJsonRepositories } from "../dist/infrastructure/json/repositories.js";
import { createPostgresRepositories } from "../dist/infrastructure/postgres-repositories.js";
import { createApp } from "../dist/app.js";
const invalid = (e) => e.code === "invalid_proof",
  unavailable = (e) => e.code === "unavailable",
  conflict = (e) => e.code === "conflict";
const suspend = { expectedStatus: "ACTIVE", status: "SUSPENDED" },
  activate = { expectedStatus: "SUSPENDED", status: "ACTIVE" };
async function fixture(t, provider = "json") {
  const f = await authFixture(t, provider);
  await f.setUser({ mustChangePassword: false }, 0);
  if (provider === "postgresql")
    for (const o of f.data.orders)
      await f.pool.query(
        "INSERT INTO orders(id,company_id,created_by_user_id,created_at,order_status,integration_status) VALUES($1,$2,$3,$4,$5,$6)",
        [
          o.id,
          o.companyId,
          o.createdByUserId,
          o.createdAt,
          o.status,
          o.integrationStatus,
        ],
      );
  f.statusRepository =
    provider === "json"
      ? createJsonAccountStatus(f.security, f.now)
      : createPostgresAccountStatus(f.pool, f.now);
  f.status = createAccountStatus(f.statusRepository, f.record);
  f.actor = async (index = 0) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(index)).accessToken,
      "profile.read",
    );
  f.repositories =
    provider === "json"
      ? createJsonRepositories(f.security.store)
      : createPostgresRepositories(f.pool);
  return f;
}
async function serve(t, f, logs = []) {
  const server = createApp({
    sessions: f.auth,
    accountStatus: f.status,
    logger: (level, event) => logs.push({ level, event }),
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return "http://127.0.0.1:" + server.address().port + "/api/v1/admin/";
}
const get = (url, token, extra = {}) =>
  fetch(url, {
    headers: {
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...extra,
    },
  });
const patch = (url, token, body, extra = {}) =>
  fetch(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
  };
  test(
    provider +
      ": suspension/reactivation preserves user credential/must-change/history and never revives an old session",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        actor = await f.actor(),
        target = f.data.users[2],
        login = await f.login(2),
        other = await f.login(4),
        before = await f.user(2);
      const change = await f.status.change(
        actor,
        "user",
        target.id,
        suspend,
        randomUUID(),
      );
      assert.deepEqual(change, {
        target: { id: target.id, kind: "user", status: "SUSPENDED" },
      });
      await assert.rejects(
        f.auth.authenticateAccess(login.accessToken),
        invalid,
      );
      await assert.rejects(
        f.auth.refresh({ refreshToken: login.refreshToken }, randomUUID()),
        invalid,
      );
      await assert.rejects(f.login(2), (e) => e.code === "invalid_credentials");
      await f.auth.authenticateAccess(other.accessToken);
      await f.status.change(actor, "user", target.id, activate, randomUUID());
      const after = await f.user(2);
      assert.equal(after.passwordHash, before.passwordHash);
      assert.equal(after.mustChangePassword, true);
      assert.equal(after.id, before.id);
      await assert.rejects(
        f.auth.authenticateAccess(login.accessToken),
        invalid,
      );
      assert.equal((await f.login(2)).user.mustChangePassword, true);
      assert.equal(
        (
          await f.repositories.orders.list(
            { companyId: target.companyId },
            { offset: 0, limit: 20 },
          )
        ).total,
        2,
      );
      const audit =
        provider === "json"
          ? JSON.parse(
              await fs.readFile(join(f.directory, "audit_logs.json"), "utf8"),
            )
          : (
              await f.pool.query(
                'SELECT action,actor_user_id AS "actorUserId",target_id AS "targetId",metadata FROM audit_logs',
              )
            ).rows;
      const events = audit.filter((e) =>
        ["user.suspended", "user.reactivated"].includes(e.action),
      );
      assert.equal(events.length, 2);
      assert.ok(
        events.every(
          (e) => e.actorUserId === actor.userId && e.targetId === target.id,
        ),
      );
      for (const proof of [
        login.accessToken,
        login.refreshToken,
        f.passwordHash,
      ])
        assert.equal(JSON.stringify(audit).includes(proof), false);
    },
  );
  test(
    provider +
      ": company suspension denies both customer roles while Admin history/other company stay available, with explicit fresh-login activation",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        actor = await f.actor(),
        [a, b] = f.data.companies;
      for (const i of [2, 3, 4])
        await f.setUser({ mustChangePassword: false }, i);
      const ca = await f.login(2),
        cu = await f.login(3),
        other = await f.login(4),
        before = await f.repositories.orders.list(
          { companyId: a.id },
          { offset: 0, limit: 20 },
        );
      await f.status.change(actor, "company", a.id, suspend, randomUUID());
      for (const login of [ca, cu]) {
        await assert.rejects(
          f.auth.authenticateAccess(login.accessToken),
          invalid,
        );
        await assert.rejects(
          f.auth.refresh({ refreshToken: login.refreshToken }, randomUUID()),
          invalid,
        );
      }
      await f.auth.authenticateAccess(other.accessToken);
      assert.equal(
        (await f.status.current(actor, "company", a.id)).target.status,
        "SUSPENDED",
      );
      assert.equal(
        (await f.repositories.companies.findById({ companyId: a.id })).status,
        "SUSPENDED",
      );
      assert.deepEqual(
        await f.repositories.orders.list(
          { companyId: a.id },
          { offset: 0, limit: 20 },
        ),
        before,
      );
      assert.equal(
        (await f.repositories.companies.findById({ companyId: b.id })).status,
        "ACTIVE",
      );
      await f.status.change(actor, "company", a.id, activate, randomUUID());
      for (const login of [ca, cu])
        await assert.rejects(
          f.auth.authenticateAccess(login.accessToken),
          invalid,
        );
      assert.equal((await f.login(2)).user.mustChangePassword, false);
      await f.auth.authenticateAccess((await f.login(0)).accessToken);
    },
  );
  test(
    provider +
      ": concurrent expected-state changes have one winner; self/pending/rejected/deactivated and copied authority cannot change status",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        actor = await f.actor(),
        target = f.data.users[2];
      for (const [kind, id] of [
        ["user", target.id],
        ["company", f.data.companies[0].id],
      ]) {
        const outcomes = await Promise.allSettled([
          f.status.change(actor, kind, id, suspend, randomUUID()),
          f.status.change(actor, kind, id, suspend, randomUUID()),
        ]);
        assert.equal(
          outcomes.filter((o) => o.status === "fulfilled").length,
          1,
        );
        assert.equal(
          outcomes.filter((o) => o.status === "rejected" && conflict(o.reason))
            .length,
          1,
        );
      }
      await assert.rejects(
        f.status.change(actor, "user", actor.userId, suspend, randomUUID()),
        (e) => e.code === "forbidden",
      );
      await assert.rejects(
        f.status.change(
          { ...actor },
          "user",
          target.id,
          activate,
          randomUUID(),
        ),
        (e) => e.name === "AuthorizationError",
      );
      for (const status of ["PENDING", "REJECTED", "DEACTIVATED"]) {
        await f.setUser({ status }, 2);
        await assert.rejects(
          f.status.change(actor, "user", target.id, activate, randomUUID()),
          conflict,
        );
        assert.equal((await f.user(2)).status, status);
      }
      await assert.rejects(
        f.status.current(actor, "user", randomUUID()),
        (e) => e.code === "not_found",
      );
    },
  );
  test(
    provider +
      ": current actor state is rechecked and required audit failure never restores a committed suspended state",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        actor = await f.actor(),
        target = f.data.users[2],
        login = await f.login(2);
      f.beforeAudit = async (e) => {
        if (e.action === "user.suspended") throw new Error("PRIVATE_AUDIT");
      };
      await assert.rejects(
        f.status.change(actor, "user", target.id, suspend, randomUUID()),
        unavailable,
      );
      assert.equal((await f.user(2)).status, "SUSPENDED");
      await assert.rejects(
        f.auth.authenticateAccess(login.accessToken),
        invalid,
      );
      if (provider === "json") await f.setUser({ role: "SALES_STAFF" }, 0);
      else
        await f.pool.query("UPDATE users SET role='SALES_STAFF' WHERE id=$1", [
          actor.userId,
        ]);
      await assert.rejects(
        f.status.change(actor, "user", target.id, activate, randomUUID()),
        (e) => e.code === "forbidden",
      );
      if (provider === "json") await f.setUser({ role: "INTERNAL_ADMIN" }, 0);
      else
        await f.pool.query(
          "UPDATE users SET role='INTERNAL_ADMIN' WHERE id=$1",
          [actor.userId],
        );
      await f.setUser({ status: "SUSPENDED" }, 0);
      await assert.rejects(
        f.status.change(actor, "user", target.id, activate, randomUUID()),
        invalid,
      );
      assert.equal((await f.user(2)).status, "SUSPENDED");
    },
  );
  test(
    provider +
      ": mutual Admin suspension serializes actor revalidation and leaves one active Admin",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        second = {
          ...f.data.users[0],
          id: randomUUID(),
          email: "second-admin@example.test",
          mustChangePassword: false,
        };
      f.data.users.push(second);
      const index = f.data.users.length - 1;
      if (provider === "json")
        await f.security.run(async () => {
          const rows = await f.security.store.read("users");
          await f.security.store.replace("users", [...rows, second]);
        });
      else
        await f.pool.query(
          "INSERT INTO users(id,email,password_hash,display_name,role,status,must_change_password) VALUES($1,$2,$3,$4,'INTERNAL_ADMIN','ACTIVE',false)",
          [second.id, second.email, f.passwordHash, second.displayName],
        );
      const a = await f.actor(),
        b = await f.actor(index);
      const results = await Promise.allSettled([
        f.status.change(a, "user", b.userId, suspend, randomUUID()),
        f.status.change(b, "user", a.userId, suspend, randomUUID()),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.filter((r) => r.status === "rejected" && invalid(r.reason))
          .length,
        1,
      );
      const users =
        provider === "json"
          ? await f.security.store.read("users")
          : (await f.pool.query("SELECT role,status FROM users")).rows;
      assert.equal(
        users.filter(
          (u) => u.role === "INTERNAL_ADMIN" && u.status === "ACTIVE",
        ).length,
        1,
      );
    },
  );
}
test("JSON suspension publication and activation cleanup failures keep old proof denied across reopen", async (t) => {
  for (const kind of ["user", "company"])
    for (const stage of ["before", "after", "cleanup"])
      await t.test(kind + "/" + stage, async (t) => {
        const f = await fixture(t),
          actor = await f.actor(),
          id = kind === "user" ? f.data.users[2].id : f.data.companies[0].id,
          login = await f.login(2);
        const options = {
          io: {
            ...fs,
            rename: async (...args) => {
              if (stage === "cleanup") throw new Error("PRIVATE_CLEANUP");
              return fs.rename(...args);
            },
          },
        };
        options[kind === "user" ? "writeUsers" : "writeCompanies"] = async (
          rows,
        ) => {
          if (stage === "before") throw new Error("PRIVATE_BEFORE");
          await f.security.store.replace(
            kind === "user" ? "users" : "companies",
            rows,
          );
          if (stage === "after") throw new Error("PRIVATE_AFTER");
        };
        const service = createAccountStatus(
          createJsonAccountStatus(f.security, f.now, options),
          f.record,
        );
        await assert.rejects(
          service.change(actor, kind, id, suspend, randomUUID()),
          unavailable,
        );
        const reopened = createJsonAccountStatus(
          new JsonSecurityCoordinator(f.directory),
          f.now,
        );
        if (stage === "before") {
          assert.equal(
            (await reopened.current(actor, kind, id)).status,
            "ACTIVE",
          );
          await f.auth.authenticateAccess(login.accessToken);
        } else {
          assert.equal(
            (await reopened.current(actor, kind, id)).status,
            "SUSPENDED",
          );
          await assert.rejects(
            f.auth.authenticateAccess(login.accessToken),
            invalid,
          );
          const failing = createJsonAccountStatus(f.security, f.now, {
            io: {
              ...fs,
              rename: async () => {
                throw new Error("PRIVATE_REACTIVATION_CLEANUP");
              },
            },
          });
          await assert.rejects(
            createAccountStatus(failing, f.record).change(
              actor,
              kind,
              id,
              activate,
              randomUUID(),
            ),
            unavailable,
          );
          assert.equal(
            (await reopened.current(actor, kind, id)).status,
            "SUSPENDED",
          );
          await reopened.change(actor, kind, id, "SUSPENDED", "ACTIVE");
          await assert.rejects(
            f.auth.authenticateAccess(login.accessToken),
            invalid,
          );
        }
      });
});
test("actual JSON termination after suspension publication cannot revive old proof on later activation", async (t) => {
  const f = await fixture(t),
    actor = await f.actor(),
    target = f.data.users[2],
    login = await f.login(2);
  const script = `import {JsonSecurityCoordinator} from './apps/api/dist/infrastructure/json/security.js';
    import {createJsonAccountStatus} from './apps/api/dist/infrastructure/json/account-status.js';
    const s=new JsonSecurityCoordinator(process.env.SYNTHETIC_DIRECTORY);
    const r=createJsonAccountStatus(s,()=>Number(process.env.SYNTHETIC_NOW),{writeUsers:async(rows)=>{await s.store.replace('users',rows);process.send({published:true});await new Promise(()=>{});}});
    await r.change({userId:process.env.SYNTHETIC_ACTOR,sessionId:process.env.SYNTHETIC_SESSION},'user',process.env.SYNTHETIC_TARGET,'ACTIVE','SUSPENDED');`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("../../../", import.meta.url),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      SYNTHETIC_DIRECTORY: f.directory,
      SYNTHETIC_NOW: String(f.now()),
      SYNTHETIC_ACTOR: actor.userId,
      SYNTHETIC_SESSION: actor.sessionId,
      SYNTHETIC_TARGET: target.id,
    },
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const ack = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() =>
      assert.fail("child exited before publication"),
    ),
  ]);
  assert.equal(ack[0].published, true);
  child.kill();
  await once(child, "exit");
  await assert.rejects(f.auth.authenticateAccess(login.accessToken), invalid);
  const repo = createJsonAccountStatus(
    new JsonSecurityCoordinator(f.directory),
    f.now,
  );
  await repo.change(actor, "user", target.id, "SUSPENDED", "ACTIVE");
  await assert.rejects(f.auth.authenticateAccess(login.accessToken), invalid);
  assert.equal((await f.user(2)).mustChangePassword, true);
});
test(
  "SQL session revocation failure rolls back status and history together",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, "postgresql"),
      actor = await f.actor(),
      target = f.data.users[2],
      login = await f.login(2);
    await f.pool.query(
      "CREATE FUNCTION reject_status_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_CLEANUP'; END $$; CREATE TRIGGER reject_status_cleanup BEFORE UPDATE ON user_sessions FOR EACH ROW EXECUTE FUNCTION reject_status_cleanup()",
    );
    await assert.rejects(
      f.status.change(actor, "user", target.id, suspend, randomUUID()),
      unavailable,
    );
    assert.equal((await f.user(2)).status, "ACTIVE");
    assert.equal((await f.user(2)).passwordHash, f.passwordHash);
    await f.auth.authenticateAccess(login.accessToken);
    assert.equal(
      (await f.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n,
      3,
    );
  },
);
test("JSON actor hard expiry is checked after coordinator wait before a status mutation", async (t) => {
  const f = await fixture(t),
    actor = await f.actor(),
    target = f.data.users[2],
    entered = barrier(),
    release = barrier();
  const held = f.security.run(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const changing = f.status.change(
    actor,
    "user",
    target.id,
    suspend,
    randomUUID(),
  );
  f.clock.value += 8 * 86400000;
  release.resolve();
  await held;
  await assert.rejects(changing, invalid);
  assert.equal((await f.user(2)).status, "ACTIVE");
});
test("status HTTP enforces all roles, body/target restrictions, no-store envelopes and private logs", async (t) => {
  const f = await fixture(t),
    logs = [],
    url = await serve(t, f, logs),
    admin = await f.login(),
    target = f.data.users[2],
    path = url + "users/" + target.id + "/status";
  for (const i of [1, 2, 3]) {
    await f.setUser({ mustChangePassword: false }, i);
    const login = await f.login(i);
    assert.equal(
      (await get(path, login.accessToken, { "x-role": "INTERNAL_ADMIN" }))
        .status,
      403,
    );
    assert.equal((await patch(path, login.accessToken, suspend)).status, 403);
  }
  assert.equal(
    (await get(path, undefined, { "x-role": "INTERNAL_ADMIN" })).status,
    401,
  );
  const current = await get(path, admin.accessToken);
  assert.equal(current.status, 200);
  assert.equal(current.headers.get("cache-control"), "no-store");
  assert.deepEqual((await current.json()).data, {
    target: { id: target.id, kind: "user", status: "ACTIVE" },
  });
  for (const body of [
    {},
    { status: "ACTIVE" },
    { ...suspend, role: "INTERNAL_ADMIN" },
    { expectedStatus: "PENDING", status: "ACTIVE" },
    { expectedStatus: "ACTIVE", status: "ACTIVE" },
  ])
    assert.equal((await patch(path, admin.accessToken, body)).status, 400);
  assert.equal(
    (
      await patch(path, admin.accessToken, suspend, {
        "content-type": "text/plain",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await patch(path, admin.accessToken, suspend, {
        "content-encoding": "gzip",
      })
    ).status,
    415,
  );
  assert.equal(
    (await patch(path, admin.accessToken, { private: "PRIVATE".repeat(1000) }))
      .status,
    413,
  );
  assert.equal(
    (await get(path + "?companyId=" + randomUUID(), admin.accessToken)).status,
    400,
  );
  const changed = await patch(path, admin.accessToken, suspend);
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get("set-cookie"), null);
  assert.equal((await patch(path, admin.accessToken, suspend)).status, 409);
  assert.equal(
    (
      await patch(
        url + "users/" + admin.user.id + "/status",
        admin.accessToken,
        suspend,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await get(
        url + "companies/" + randomUUID() + "/status",
        admin.accessToken,
      )
    ).status,
    404,
  );
  const serialized = JSON.stringify(logs);
  for (const value of [
    admin.accessToken,
    admin.refreshToken,
    f.passwordHash,
    "PRIVATE",
  ])
    assert.equal(serialized.includes(value), false);
});
test(
  "SQL actor proof is rechecked after the real user lock wait before status commit",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, "postgresql"),
      actor = await f.actor(),
      target = f.data.users[2],
      entered = barrier();
    const blocker = await f.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      actor.userId,
    ]);
    const pool = {
      connect: async () => {
        const c = await f.pool.connect();
        return {
          on: c.on.bind(c),
          off: c.off.bind(c),
          release: c.release.bind(c),
          query: (...args) => {
            const result = c.query(...args);
            if (
              typeof args[0] === "string" &&
              args[0].includes("ORDER BY id FOR UPDATE")
            )
              entered.resolve();
            return result;
          },
        };
      },
    };
    try {
      const service = createAccountStatus(
        createPostgresAccountStatus(pool, f.now),
        f.record,
      );
      const changing = service.change(
        actor,
        "user",
        target.id,
        suspend,
        randomUUID(),
      );
      await entered.promise;
      f.clock.value += 8 * 86400000;
      await blocker.query("COMMIT");
      await assert.rejects(changing, invalid);
      assert.equal((await f.user(2)).status, "ACTIVE");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  },
);
test("SQL acquisition failures are controlled and do not disclose driver errors", async () => {
  const repository = createPostgresAccountStatus({
    connect: async () => {
      throw new Error("PRIVATE_CONNECT_FAILURE");
    },
  });
  await assert.rejects(
    repository.current(
      { userId: randomUUID(), sessionId: randomUUID() },
      "user",
      randomUUID(),
    ),
    (e) => unavailable(e) && !e.message.includes("PRIVATE"),
  );
});
