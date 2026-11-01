import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { decodeJwt } from "jose";
import {
  authFixture,
  oldPassword,
  newPassword,
  barrier,
} from "./helpers/auth-fixture.mjs";
import {
  hashPassword,
  verifyPassword,
} from "../dist/infrastructure/passwords.js";
import { createPasswordChange } from "../dist/services/password-change.js";
import { JsonSecurityCoordinator } from "../dist/infrastructure/json/security.js";
import { createJsonSessions } from "../dist/infrastructure/json/sessions.js";
import { createJsonAuthentication } from "../dist/infrastructure/json/authentication.js";
import { createVerifiedLogin } from "../dist/services/login.js";
import { createSessions } from "../dist/services/sessions.js";
import { createAccessTokens } from "../dist/infrastructure/access-tokens.js";
import { sessionProofs } from "../dist/infrastructure/session-crypto.js";
import { createApp } from "../dist/app.js";
import { createJsonApplications } from "../dist/infrastructure/json/applications.js";
import { checkedApplication } from "../dist/services/applications.js";

const body = { currentPassword: oldPassword, newPassword };
const invalid = (e) => e.code === "invalid_proof";
const unavailable = (e) => e.code === "unavailable";
test("JSON application publication and password change serialize without overwriting either account", async (t) => {
  const f = await authFixture(t);
  const login = await f.login();
  const run = f.security.run.bind(f.security);
  let active = 0,
    maximum = 0;
  f.security.run = (operation) =>
    run(async () => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await operation();
      } finally {
        active--;
      }
    });
  const paused = barrier(),
    release = barrier();
  const applications = createJsonApplications(
    f.directory,
    f.security.store,
    async (stage) => {
      if (stage === "companies") {
        paused.resolve();
        await release.promise;
      }
    },
    f.security,
  );
  const record = checkedApplication({
    companyName: "Concurrent Synthetic Company",
    tradeLicenseReference: "Concurrent-1",
    businessEmail: "concurrent-business@example.test",
    phone: "555",
    billingAddress: "Billing",
    deliveryAddress: "Delivery",
    administratorName: "Concurrent Admin",
    administratorEmail: "concurrent-admin@example.test",
    administratorMobile: "556",
    companyId: randomUUID(),
    administratorUserId: randomUUID(),
    deliveryAddressId: randomUUID(),
    passwordHash: f.passwordHash,
    createdAt: new Date(f.now()).toISOString(),
  });
  const submission = applications.submit(record);
  await paused.promise;
  assert.equal(
    active,
    1,
    "application publication holds the shared coordinator",
  );
  const change = f.change()(login.accessToken, body, randomUUID());
  release.resolve();
  await Promise.all([submission, change]);
  assert.equal(maximum, 1);
  const users = await f.security.store.read("users");
  assert.equal(users.length, f.data.users.length + 1);
  assert.equal(
    users.find((u) => u.id === record.administratorUserId).status,
    "PENDING",
  );
  const changed = users.find((u) => u.id === f.data.users[0].id);
  assert.equal(changed.mustChangePassword, false);
  assert.equal(await verifyPassword(newPassword, changed.passwordHash), true);
  await assert.rejects(f.auth.authenticateAccess(login.accessToken), invalid);
});
async function serve(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return "http://127.0.0.1:" + server.address().port;
}
const post = (url, value, token, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...headers,
    },
    body: JSON.stringify(value),
  });
test("first-login password policy rejects malformed/spoofed/reused/oversized input before credential work", async () => {
  const fail = () =>
    assert.fail("invalid input reached authentication/storage");
  const change = createPasswordChange(
    { current: fail, change: fail },
    fail,
    fail,
    fail,
    fail,
  );
  for (const value of [
    null,
    [],
    {},
    body.currentPassword,
    { ...body, role: "INTERNAL_ADMIN" },
    { ...body, newPassword: oldPassword },
    { ...body, newPassword: "short1!" },
    { ...body, newPassword: "lowercase123!" },
    { ...body, newPassword: "UppercaseOnly!" },
    { ...body, newPassword: "Uppercase123" },
    { ...body, currentPassword: "é".repeat(513) },
    { ...body, newPassword: "A1!" + "é".repeat(513) },
  ])
    await assert.rejects(
      change("invalid", value, randomUUID()),
      (e) => e.code === "invalid_input",
    );
});
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
    timeout: 30000,
  };
  test(
    provider +
      ": password change clears first-login, requires fresh login and invalidates all own sessions only",
    options,
    async (t) => {
      const f = await authFixture(t, provider),
        first = await f.login(),
        second = await f.login(),
        other = await f.login(2);
      const result = await f.change()(first.accessToken, body, randomUUID());
      assert.deepEqual(result, { requiresLogin: true });
      const user = await f.user();
      assert.equal(user.mustChangePassword, false);
      assert.notEqual(user.passwordHash, f.passwordHash);
      assert.ok(await verifyPassword(newPassword, user.passwordHash));
      for (const old of [first, second]) {
        await assert.rejects(
          f.auth.authenticateAccess(old.accessToken),
          invalid,
        );
        await assert.rejects(
          f.auth.refresh({ refreshToken: old.refreshToken }, randomUUID()),
          invalid,
        );
      }
      assert.ok(
        (await f.rows())
          .filter((r) => r.userId === f.data.users[0].id)
          .every((r) => r.revokedAt !== null),
      );
      assert.ok(await f.auth.authenticateAccess(other.accessToken));
      await assert.rejects(
        f.login(0, oldPassword),
        (e) => e.code === "invalid_credentials",
      );
      const fresh = await f.login(0, newPassword);
      assert.equal(fresh.user.mustChangePassword, false);
      assert.equal(
        (await f.auth.authenticateAccess(fresh.accessToken)).mustChangePassword,
        false,
      );
    },
  );
  test(
    provider +
      ": normal/inactive/expired users and wrong current password cannot change credentials; hash failure is safe",
    options,
    async (t) => {
      const f = await authFixture(t, provider),
        proof = await f.login(),
        original = await f.user();
      await assert.rejects(
        f.change()(
          proof.accessToken,
          { ...body, currentPassword: "wrong current password" },
          randomUUID(),
        ),
        (e) => e.code === "invalid_credentials",
      );
      await assert.rejects(
        f.change(async () => {
          throw new Error("PRIVATE_HASH_FAILURE");
        })(proof.accessToken, body, randomUUID()),
        unavailable,
      );
      assert.deepEqual(await f.user(), original);
      assert.ok(await f.auth.authenticateAccess(proof.accessToken));
      await f.setUser({ status: "SUSPENDED" });
      await assert.rejects(
        f.change()(proof.accessToken, body, randomUUID()),
        invalid,
      );
      await f.setUser({ status: "ACTIVE", mustChangePassword: false });
      const normal = await f.login();
      await assert.rejects(
        f.change()(normal.accessToken, body, randomUUID()),
        (e) => e.code === "not_required",
      );
      await f.setUser({ mustChangePassword: true });
      const expiring = await f.login();
      f.clock.value += 604800000;
      await assert.rejects(
        f.change()(expiring.accessToken, body, randomUUID()),
        invalid,
      );
      assert.equal((await f.user()).passwordHash, f.passwordHash);
    },
  );
  test(
    provider +
      ": two verified changes race at the credential boundary and exactly one wins",
    options,
    async (t) => {
      const f = await authFixture(t, provider),
        proof = await f.login(),
        ready = barrier();
      let count = 0;
      const hash = async (password) => {
        const encoded = await hashPassword(password);
        if (++count === 2) ready.resolve();
        await ready.promise;
        return encoded;
      };
      const change = f.change(hash);
      const results = await Promise.allSettled([
        change(proof.accessToken, body, randomUUID()),
        change(
          proof.accessToken,
          { ...body, newPassword: "AnotherReplacement789!" },
          randomUUID(),
        ),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.find((r) => r.status === "rejected").reason.code,
        "invalid_proof",
      );
      const stored = await f.user();
      const expected =
        results[0].status === "fulfilled"
          ? newPassword
          : "AnotherReplacement789!";
      assert.ok(await verifyPassword(expected, stored.passwordHash));
      assert.equal((await f.login(0, expected)).user.mustChangePassword, false);
    },
  );
  test(
    provider +
      ": expiry after password work denies at commit, and required audit failure never restores changed state",
    options,
    async (t) => {
      const f = await authFixture(t, provider),
        proof = await f.login(),
        entered = barrier(),
        release = barrier();
      const delayed = f.change(async (password) => {
        const encoded = await hashPassword(password);
        entered.resolve();
        await release.promise;
        return encoded;
      });
      const pending = delayed(proof.accessToken, body, randomUUID());
      await entered.promise;
      f.clock.value += 604800000;
      release.resolve();
      await assert.rejects(pending, invalid);
      assert.equal((await f.user()).passwordHash, f.passwordHash);
      const fresh = await f.login();
      f.beforeAudit = async (input) => {
        if (input.action === "password.changed")
          throw new Error("PRIVATE_AUDIT_FAILURE");
      };
      await assert.rejects(
        f.change()(fresh.accessToken, body, randomUUID()),
        unavailable,
      );
      assert.equal((await f.user()).mustChangePassword, false);
      await assert.rejects(
        f.auth.authenticateAccess(fresh.accessToken),
        invalid,
      );
      f.beforeAudit = async () => {};
      assert.equal(
        (await f.login(0, newPassword)).user.mustChangePassword,
        false,
      );
    },
  );
}
test("JSON failure before/after credential publication and failed revocation cleanup retain safe complete state", async (t) => {
  for (const mode of ["before", "after", "cleanup"]) {
    await t.test(mode, async (t) => {
      const f = await authFixture(t),
        proof = await f.login(),
        before = await f.user();
      f.failUserBefore = mode === "before";
      f.failUserAfter = mode === "after";
      f.failCleanup = mode === "cleanup";
      await assert.rejects(
        f.change()(proof.accessToken, body, randomUUID()),
        unavailable,
      );
      if (mode === "before") {
        assert.deepEqual(await f.user(), before);
        assert.ok(await f.auth.authenticateAccess(proof.accessToken));
      } else {
        assert.equal((await f.user()).mustChangePassword, false);
        assert.ok(
          await verifyPassword(newPassword, (await f.user()).passwordHash),
        );
        assert.equal(
          (await f.rows()).find(
            (r) => r.id === decodeJwt(proof.accessToken).sid,
          ).revokedAt,
          null,
        );
        await assert.rejects(
          f.auth.authenticateAccess(proof.accessToken),
          invalid,
        );
        await assert.rejects(
          f.auth.refresh({ refreshToken: proof.refreshToken }, randomUUID()),
          invalid,
        );
      }
      f.failUserBefore = false;
      f.failUserAfter = false;
      f.failCleanup = false;
      const login = await f.login(
        0,
        mode === "before" ? oldPassword : newPassword,
      );
      assert.ok(login.accessToken);
    });
  }
});
test("JSON actual process termination before/after user publication preserves the approved restart boundary", async (t) => {
  for (const stage of ["before", "after"]) {
    await t.test(stage, async (t) => {
      const f = await authFixture(t),
        proof = await f.login(),
        replacement = await hashPassword(newPassword);
      const securityUrl = new URL(
        "../dist/infrastructure/json/security.js",
        import.meta.url,
      ).href;
      const writerUrl = new URL(
        "../dist/infrastructure/json/password-change.js",
        import.meta.url,
      ).href;
      const code = `import {JsonSecurityCoordinator} from ${JSON.stringify(securityUrl)};import {createJsonPasswordChange} from ${JSON.stringify(writerUrl)};import * as fs from "node:fs/promises";process.on("message",async({directory,stage,id,userId,oldHash,newHash})=>{const s=new JsonSecurityCoordinator(directory);const writer=async(rows)=>{if(stage==="after")await s.store.replace("users",rows);process.send(stage);await new Promise(()=>{});};await createJsonPasswordChange(s,Date.now,fs,writer).change(id,{userId,passwordHash:oldHash},newHash);});setInterval(()=>{},10000);`;
      const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", code],
          { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true },
        ),
        closed = once(child, "close");
      t.after(async () => {
        if (child.exitCode === null) child.kill();
        await closed;
      });
      child.send({
        directory: f.directory,
        stage,
        id: decodeJwt(proof.accessToken).sid,
        userId: f.data.users[0].id,
        oldHash: f.passwordHash,
        newHash: replacement,
      });
      assert.equal((await once(child, "message"))[0], stage);
      child.kill();
      await closed;
      const security = new JsonSecurityCoordinator(f.directory);
      const auth = createSessions(
        createJsonSessions(security, f.now),
        createVerifiedLogin(
          createJsonAuthentication(security.store),
          verifyPassword,
          f.record,
        ),
        f.record,
        f.config,
        createAccessTokens(f.config, f.now),
        sessionProofs,
      );
      if (stage === "after") {
        await assert.rejects(
          auth.authenticateAccess(proof.accessToken),
          invalid,
        );
        await assert.rejects(
          auth.refresh({ refreshToken: proof.refreshToken }, randomUUID()),
          invalid,
        );
        const login = await auth.login(
          { email: f.data.users[0].email, password: newPassword },
          randomUUID(),
        );
        assert.equal(login.user.mustChangePassword, false);
      } else {
        assert.equal(
          (await auth.authenticateAccess(proof.accessToken)).mustChangePassword,
          true,
        );
        assert.equal((await f.user()).mustChangePassword, true);
      }
      assert.equal((await f.rows())[0].revokedAt, null);
    });
  }
});
test(
  "SQL revocation failure rolls back the credential and flag in the same transaction",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL, timeout: 30000 },
  async (t) => {
    const f = await authFixture(t, "postgresql"),
      proof = await f.login(),
      before = await f.user();
    await f.admin.query(
      "CREATE FUNCTION fail_password_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_CLEANUP_FAILURE'; END $$",
    );
    await f.admin.query(
      "CREATE TRIGGER fail_password_cleanup BEFORE UPDATE ON user_sessions FOR EACH ROW EXECUTE FUNCTION fail_password_cleanup()",
    );
    await assert.rejects(
      f.change()(proof.accessToken, body, randomUUID()),
      unavailable,
    );
    assert.deepEqual(await f.user(), before);
    assert.equal((await f.rows())[0].revokedAt, null);
    assert.ok(await f.auth.authenticateAccess(proof.accessToken));
    await f.admin.query("DROP TRIGGER fail_password_cleanup ON user_sessions");
    assert.deepEqual(await f.change()(proof.accessToken, body, randomUUID()), {
      requiresLogin: true,
    });
  },
);
test("password-change HTTP returns only fresh-login outcome, safe errors and private no-store logs", async (t) => {
  const f = await authFixture(t),
    proof = await f.login(),
    logs = [];
  const url = await serve(
    t,
    createApp({
      sessions: f.auth,
      passwordChange: f.change(),
      logger: (_level, event) => logs.push(event),
    }),
  );
  assert.equal(
    (await post(url + "/api/v1/auth/change-password", body)).status,
    401,
  );
  assert.equal(
    (
      await post(
        url + "/api/v1/auth/change-password",
        { ...body, userId: f.data.users[2].id },
        proof.accessToken,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await post(
        url + "/api/v1/auth/change-password",
        { ...body, currentPassword: "wrong password" },
        proof.accessToken,
      )
    ).status,
    401,
  );
  const response = await post(
    url + "/api/v1/auth/change-password",
    body,
    proof.accessToken,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual((await response.json()).data, { requiresLogin: true });
  assert.equal(
    (await post(url + "/api/v1/auth/change-password", body, proof.accessToken))
      .status,
    401,
  );
  for (const secret of [
    oldPassword,
    newPassword,
    f.passwordHash,
    proof.accessToken,
    proof.refreshToken,
    "passwordHash",
    "credentialFingerprint",
  ])
    assert.ok(!JSON.stringify(logs).includes(secret));
});
test("password-change HTTP enforces media/body/attempt limits and remains unavailable without configured service", async (t) => {
  const f = await authFixture(t),
    url = await serve(
      t,
      createApp({ passwordChange: f.change(), logger: () => {} }),
    ),
    route = url + "/api/v1/auth/change-password";
  assert.equal(
    (await post(route, body, undefined, { "content-type": "text/plain" }))
      .status,
    415,
  );
  assert.equal(
    (await post(route, { ...body, newPassword: "x".repeat(5000) })).status,
    413,
  );
  assert.equal(
    (
      await fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
  for (let n = 3; n < 10; n++)
    assert.equal((await post(route, body)).status, 401);
  const limited = await post(route, body);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  const absent = await serve(t, createApp({ logger: () => {} }));
  assert.equal(
    (await post(absent + "/api/v1/auth/change-password", body)).status,
    503,
  );
});
