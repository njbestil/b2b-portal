import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { decodeJwt } from "jose";
import { logoutFixture, barrier } from "./helpers/logout-fixture.mjs";
import { createApp } from "../dist/app.js";
import { createJsonSessions } from "../dist/infrastructure/json/sessions.js";
import { JsonSecurityCoordinator } from "../dist/infrastructure/json/security.js";
import { createPostgresSessions } from "../dist/infrastructure/postgres-sessions.js";

async function serve(t, options) {
  const server = createApp(options).listen(0, "127.0.0.1");
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
const post = (url, token, body = {}, extra = {}) =>
  fetch(url + "/api/v1/auth/logout", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
const invalid = (e) => e.code === "invalid_proof";
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
  };
  test(
    provider +
      ": HTTP logout revokes only the validated active session, persists across reopen and denies old access/refresh",
    options,
    async (t) => {
      const f = await logoutFixture(t, provider);
      await f.setUser({ mustChangePassword: false });
      const current = await f.login(),
        sibling = await f.login(),
        other = await f.login(1);
      const logs = [],
        url = await serve(t, {
          sessions: f.auth,
          logger: (level, event) => logs.push({ level, event }),
        });
      const response = await post(url, current.accessToken);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("set-cookie"), null);
      const result = await response.json();
      assert.deepEqual(result.data, { loggedOut: true });
      assert.equal(result.success, true);
      assert.equal(typeof result.requestId, "string");
      assert.equal((await post(url, current.accessToken)).status, 401);
      await assert.rejects(
        f.auth.authenticateAccess(current.accessToken),
        invalid,
      );
      await assert.rejects(
        f.auth.refresh({ refreshToken: current.refreshToken }, randomUUID()),
        invalid,
      );
      await f.auth.authenticateAccess(sibling.accessToken);
      await f.auth.authenticateAccess(other.accessToken);
      const reopened =
        provider === "json"
          ? createJsonSessions(new JsonSecurityCoordinator(f.directory), f.now)
          : createPostgresSessions(f.pool, f.now);
      const sid = decodeJwt(current.accessToken).sid;
      await assert.rejects(reopened.admit(sid, current.user.id), invalid);
      // Persistence operation is idempotent, whereas a later HTTP admission is denied.
      await reopened.revoke(sid, current.user.id);
      const rows = await f.rows();
      assert.equal(rows.filter((r) => r.revokedAt !== null).length, 1);
      const serialized = JSON.stringify({ logs, result });
      for (const secret of [
        current.accessToken,
        current.refreshToken,
        f.passwordHash,
        "passwordHash",
        "credentialFingerprint",
      ])
        assert.equal(serialized.includes(secret), false);
    },
  );
  test(
    provider +
      ": restricted users may logout; concurrent repeats are safe and later repeats deny",
    options,
    async (t) => {
      const f = await logoutFixture(t, provider),
        login = await f.login();
      const url = await serve(t, { sessions: f.auth, logger: () => {} });
      const responses = await Promise.all([
        post(url, login.accessToken),
        post(url, login.accessToken),
      ]);
      assert.ok(responses.some((r) => r.status === 200));
      assert.ok(responses.every((r) => [200, 401].includes(r.status)));
      assert.equal((await post(url, login.accessToken)).status, 401);
      assert.equal(
        (await f.rows()).filter((r) => r.revokedAt !== null).length,
        1,
      );
    },
  );
  test(
    provider + ": invalid/expired/inactive proof never revokes another session",
    options,
    async (t) => {
      const f = await logoutFixture(t, provider),
        login = await f.login(),
        other = await f.login(1);
      const url = await serve(t, { sessions: f.auth, logger: () => {} });
      for (const token of [undefined, "not-a-jwt", login.refreshToken])
        assert.equal((await post(url, token)).status, 401);
      const saved = f.clock.value;
      f.clock.value += 931000;
      assert.equal((await post(url, login.accessToken)).status, 401);
      f.clock.value = saved;
      await f.setUser({ status: "SUSPENDED" });
      assert.equal((await post(url, login.accessToken)).status, 401);
      assert.equal(
        (await f.rows()).filter((r) => r.revokedAt !== null).length,
        0,
      );
      await f.auth.authenticateAccess(other.accessToken);
    },
  );
  test(
    provider +
      ": a refresh admitted before logout can finish but its returned proofs already deny",
    options,
    async (t) => {
      const f = await logoutFixture(t, provider),
        login = await f.login(),
        paused = barrier(),
        release = barrier();
      f.beforeAudit = async (event) => {
        if (event.action === "session.refreshed") {
          paused.resolve();
          await release.promise;
        }
      };
      const url = await serve(t, { sessions: f.auth, logger: () => {} });
      const refreshing = f.auth.refresh(
        { refreshToken: login.refreshToken },
        randomUUID(),
      );
      await paused.promise;
      assert.equal((await post(url, login.accessToken)).status, 200);
      release.resolve();
      const rotated = await refreshing;
      await assert.rejects(
        f.auth.authenticateAccess(rotated.accessToken),
        invalid,
      );
      await assert.rejects(
        f.auth.refresh({ refreshToken: rotated.refreshToken }, randomUUID()),
        invalid,
      );
    },
  );
  test(
    provider +
      ": required audit failure after logout returns 503 and never restores committed revocation",
    options,
    async (t) => {
      const f = await logoutFixture(t, provider),
        login = await f.login();
      f.beforeAudit = async (event) => {
        if (event.action === "session.revoked")
          throw new Error("PRIVATE_AUDIT_FAILURE");
      };
      const url = await serve(t, { sessions: f.auth, logger: () => {} });
      const response = await post(url, login.accessToken);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "AUTH_UNAVAILABLE");
      await assert.rejects(
        f.auth.authenticateAccess(login.accessToken),
        invalid,
      );
      await assert.rejects(
        f.auth.refresh({ refreshToken: login.refreshToken }, randomUUID()),
        invalid,
      );
      assert.equal((await post(url, login.accessToken)).status, 401);
    },
  );
  test(
    provider +
      ": failed revocation publication is unavailable, preserves the uncommitted session and can recover",
    options,
    async (t) => {
      const f = await logoutFixture(t, provider),
        login = await f.login();
      if (provider === "json") f.failPublication = true;
      else
        await f.admin.query(
          "CREATE FUNCTION reject_logout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_WRITE_FAILURE'; END $$; CREATE TRIGGER reject_logout BEFORE UPDATE ON user_sessions FOR EACH ROW EXECUTE FUNCTION reject_logout()",
        );
      const url = await serve(t, { sessions: f.auth, logger: () => {} });
      const response = await post(url, login.accessToken);
      assert.equal(response.status, 503);
      assert.equal(
        JSON.stringify(await response.json()).includes("PRIVATE"),
        false,
      );
      assert.equal((await f.rows())[0].revokedAt, null);
      if (provider === "json") f.failPublication = false;
      else await f.admin.query("DROP TRIGGER reject_logout ON user_sessions");
      await f.auth.authenticateAccess(login.accessToken);
      assert.equal((await post(url, login.accessToken)).status, 200);
    },
  );
}
test("logout HTTP refuses body selectors, unsafe parsing/media, ambiguous bearer and over-limit attempts without reflecting input", async (t) => {
  const f = await logoutFixture(t),
    login = await f.login(),
    logs = [];
  const url = await serve(t, {
    sessions: f.auth,
    logger: (level, event) => logs.push({ level, event }),
  });
  for (const body of [
    null,
    [],
    { userId: login.user.id },
    { sessionId: randomUUID() },
    { role: "INTERNAL_ADMIN" },
  ]) {
    const response = await post(url, login.accessToken, body);
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).error.code,
      body === null ? "INVALID_JSON" : "INVALID_SESSION_REQUEST",
    );
  }
  assert.equal(
    (await post(url, login.accessToken + ", Bearer other")).status,
    401,
  );
  assert.equal(
    (await post(url, login.accessToken, {}, { "content-type": "text/plain" }))
      .status,
    415,
  );
  assert.equal(
    (await post(url, login.accessToken, {}, { "content-encoding": "gzip" }))
      .status,
    415,
  );
  assert.equal(
    (await post(url, login.accessToken, { large: "PRIVATE".repeat(1000) }))
      .status,
    413,
  );
  assert.equal(
    (
      await fetch(url + "/api/v1/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
  await f.auth.authenticateAccess(login.accessToken);
  let response;
  for (let n = 0; n < 31; n++)
    response = await post(url, undefined, {}, { "x-forwarded-for": String(n) });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  const data = JSON.stringify(logs);
  assert.equal(data.includes(login.accessToken), false);
  assert.equal(data.includes("PRIVATE"), false);
  const unconfigured = await serve(t, { logger: () => {} });
  assert.equal((await post(unconfigured, login.accessToken)).status, 503);
});
test("logout HTTP bounds in-flight work and releases capacity", async (t) => {
  const entered = barrier(),
    release = barrier();
  let count = 0;
  const service = {
    revoke: async () => {
      if (++count === 8) entered.resolve();
      await release.promise;
    },
  };
  const url = await serve(t, { sessions: service, logger: () => {} });
  const pending = Array.from({ length: 8 }, () => post(url, "synthetic"));
  await entered.promise;
  assert.equal((await post(url, "synthetic")).status, 503);
  release.resolve();
  assert.ok((await Promise.all(pending)).every((r) => r.status === 200));
  assert.equal((await post(url, "synthetic")).status, 200);
});
