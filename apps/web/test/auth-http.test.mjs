import assert from "node:assert/strict";
import test from "node:test";
import { SessionClient } from "../src/features/authentication/session.ts";
const id = "12345678-1234-4234-8234-123456789abc",
  now = Date.now();
const user = {
  id,
  companyId: null,
  displayName: "Synthetic Operator",
  role: "INTERNAL_ADMIN",
  mustChangePassword: true,
};
const tokens = () => ({
  user,
  accessToken: "synthetic-access",
  refreshToken: "synthetic-refresh",
  tokenType: "Bearer",
  expiresIn: 900,
  refreshExpiresAt: new Date(now + 600000).toISOString(),
});
const ok = (data, status = 200) =>
  new Response(JSON.stringify({ success: true, requestId: id, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
const fail = (status, code) =>
  new Response(
    JSON.stringify({
      success: false,
      requestId: id,
      error: { code, message: "DO_NOT_RENDER" },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
test("first-login posts exact passwords with restricted Bearer proof, then clears proof and requires fresh login", async () => {
  const calls = [],
    client = new SessionClient(
      async (path, init) => {
        calls.push({ path, init });
        return ok(path.endsWith("login") ? tokens() : { requiresLogin: true });
      },
      () => now,
    );
  await client.login("operator@example.test", " temporary ");
  await client.changeInitialPassword(" temporary ", " New-password-1! ");
  const call = calls[1];
  assert.equal(call.path, "/api/v1/auth/change-password");
  assert.deepEqual(JSON.parse(call.init.body), {
    currentPassword: " temporary ",
    newPassword: " New-password-1! ",
  });
  assert.equal(call.init.headers.Authorization, "Bearer synthetic-access");
  assert.equal(call.init.credentials, "omit");
  assert.equal(client.snapshot(), null);
  assert.equal(client.notice, "password-changed");
  await assert.rejects(client.read("/api/v1/company"), { code: "session" });
});
test("wrong temporary credential permits correction; uncertain change clears proof without replay", async () => {
  let response = fail(401, "INVALID_CREDENTIALS"),
    changes = 0;
  const client = new SessionClient(
    async (path) => {
      if (path.endsWith("login")) return ok(tokens());
      changes++;
      return response;
    },
    () => now,
  );
  await client.login("operator@example.test", "temporary");
  await assert.rejects(
    client.changeInitialPassword("wrong", "New-password-1!"),
    { code: "credentials" },
  );
  assert.equal(client.snapshot().mustChangePassword, true);
  response = fail(503, "AUTH_UNAVAILABLE");
  await assert.rejects(
    client.changeInitialPassword("temporary", "New-password-1!"),
    { code: "unavailable" },
  );
  assert.equal(changes, 2);
  assert.equal(client.snapshot(), null);
  assert.equal(client.notice, "password-uncertain");
});
test("forgot/reset are anonymous exact-body requests; only the documented receipt/success may advance", async () => {
  const calls = [],
    client = new SessionClient(async (path, init) => {
      calls.push({ path, init });
      return path.endsWith("forgot-password")
        ? ok({ received: true }, 202)
        : ok({ requiresLogin: true });
    });
  await client.requestRecovery("operator@example.test");
  await client.redeemRecovery("synthetic-proof", "New-password-1!");
  assert.equal(calls[0].path, "/api/v1/auth/forgot-password");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    email: "operator@example.test",
  });
  assert.equal(calls[1].path, "/api/v1/auth/reset-password");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    token: "synthetic-proof",
    newPassword: "New-password-1!",
  });
  for (const call of calls) {
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal(call.init.credentials, "omit");
  }
  assert.equal(client.notice, "password-changed");
  for (const response of [
    ok({ received: true }),
    ok({ received: false }, 202),
    new Response("SPA fallback", { status: 202 }),
  ])
    await assert.rejects(
      new SessionClient(async () => response).requestRecovery(
        "operator@example.test",
      ),
      { code: "unavailable" },
    );
});
test("invalid/used proof and rate errors stay safe, malformed reset success cannot sign in", async () => {
  await assert.rejects(
    new SessionClient(async () =>
      fail(401, "INVALID_RESET_TOKEN"),
    ).redeemRecovery("synthetic-proof", "New-password-1!"),
    { code: "proof" },
  );
  await assert.rejects(
    new SessionClient(async () => ok({ user })).redeemRecovery(
      "synthetic-proof",
      "New-password-1!",
    ),
    { code: "unavailable" },
  );
  const response = fail(429, "RESET_RATE_LIMITED");
  response.headers.set("Retry-After", "60");
  await assert.rejects(
    new SessionClient(async () => response).requestRecovery(
      "operator@example.test",
    ),
    (e) =>
      e.code === "rate" &&
      e.retryAfter === 60 &&
      !e.message.includes("DO_NOT_RENDER"),
  );
});
test("logout is single-flight, uses exact empty body, clears proofs and records uncertain revocation honestly", async () => {
  let release,
    calls = 0;
  const barrier = new Promise((r) => {
    release = r;
  });
  const client = new SessionClient(
    async (path, init) => {
      if (path.endsWith("login")) return ok(tokens());
      calls++;
      assert.equal(init.body, "{}");
      assert.equal(init.headers.Authorization, "Bearer synthetic-access");
      await barrier;
      return ok({ loggedOut: true });
    },
    () => now,
  );
  await client.login("operator@example.test", "temporary");
  const first = client.logout(),
    second = client.logout();
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(client.snapshot(), null);
  assert.equal(client.notice, "logged-out");
  const failed = new SessionClient(
    async (path) =>
      path.endsWith("login") ? ok(tokens()) : fail(503, "AUTH_UNAVAILABLE"),
    () => now,
  );
  await failed.login("operator@example.test", "temporary");
  await assert.rejects(failed.logout(), { code: "unavailable" });
  assert.equal(failed.snapshot(), null);
  assert.equal(failed.notice, "logout-uncertain");
});
test("late logout cannot clear a replacement login in the same tab", async () => {
  let release;
  const barrier = new Promise((r) => {
    release = r;
  });
  const client = new SessionClient(
    async (path) => {
      if (path.endsWith("login")) return ok(tokens());
      await barrier;
      return ok({ loggedOut: true });
    },
    () => now,
  );
  await client.login("operator@example.test", "temporary");
  const leaving = client.logout();
  // Let logout capture its old proof before an independently requested login.
  await Promise.resolve();
  await client.login("operator@example.test", "replacement");
  release();
  await leaving;
  assert.equal(client.snapshot().id, id);
  assert.equal(client.notice, null);
});

test("HTTP transport invokes browser fetch with the global receiver", async () => {
  let calls = 0;
  const client = new SessionClient(
    function () {
      assert.equal(this, globalThis);
      calls++;
      return Promise.resolve(ok(tokens()));
    },
    () => now,
  );
  await client.login("operator@example.test", "synthetic");
  assert.equal(calls, 1);
  assert.equal(client.snapshot().mustChangePassword, true);
});
