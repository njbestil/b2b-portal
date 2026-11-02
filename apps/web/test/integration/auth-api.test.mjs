import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { SessionClient } from "../../src/features/authentication/session.ts";
import {
  authFixture,
  oldPassword,
  newPassword,
} from "../../../api/test/helpers/auth-fixture.mjs";
import { createApp } from "../../../api/dist/app.js";
import { createPasswordReset } from "../../../api/dist/services/password-reset.js";
import { createJsonPasswordReset } from "../../../api/dist/infrastructure/json/password-reset.js";
import {
  hashPassword,
  verifyPassword,
} from "../../../api/dist/infrastructure/passwords.js";
import { resetProofs } from "../../../api/dist/infrastructure/reset-crypto.js";

async function fixture(t) {
  // Existing provider fixture owns fresh synthetic files; never a live demo or keys.
  const f = await authFixture(t, "json");
  assert.ok(resolve(f.directory).startsWith(resolve(tmpdir()) + sep));
  const reset = createPasswordReset(
    createJsonPasswordReset(f.security, f.now),
    hashPassword,
    verifyPassword,
    f.record,
    resetProofs,
  );
  const app = createApp({
    login: async () => assert.fail("credential-only fallback used"),
    sessionLogin: (input, requestId) => f.auth.login(input, requestId),
    sessions: f.auth,
    passwordChange: f.change(),
    passwordReset: reset,
    logger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new SessionClient(
    (path, init) => fetch(origin + path, init),
    f.now,
  );
  return { f, reset, client };
}
test("Web client exercises real merged JSON/HTTP login, restricted change, logout and protected-proof reset", async (t) => {
  const { f, reset, client } = await fixture(t),
    email = f.data.users[0].email;
  await client.login(email, oldPassword);
  assert.equal(client.snapshot().mustChangePassword, true);
  await assert.rejects(client.read("/api/v1/company"), { code: "restricted" });
  const replacement = "Äbcdef١🙂"; // Eight Unicode characters, Lu/N/S, no ASCII policy substitution.
  await client.changeInitialPassword(oldPassword, replacement);
  assert.equal(client.snapshot(), null);
  assert.equal(client.notice, "password-changed");
  assert.equal((await f.user()).mustChangePassword, false);
  assert.equal(
    await verifyPassword(replacement, (await f.user()).passwordHash),
    true,
  );
  await assert.rejects(client.login(email, oldPassword), {
    code: "credentials",
  });
  await client.login(email, replacement);
  assert.equal(client.snapshot().mustChangePassword, false);
  await client.logout();
  assert.equal(client.notice, "logged-out");
  assert.equal(client.snapshot(), null);
  assert.ok((await f.rows()).every((row) => row.revokedAt));
  await client.requestRecovery(email);
  await client.requestRecovery("unknown@example.test");
  // Private test operator supplies proof in memory; HTTP never returns/delivers it.
  let proof;
  await reset.issue(email, randomUUID(), async (value) => {
    proof = value;
  });
  assert.equal(typeof proof, "string");
  await client.redeemRecovery(proof, newPassword);
  assert.equal(client.notice, "password-changed");
  assert.equal(client.snapshot(), null);
  await client.login(email, newPassword);
  assert.equal(client.snapshot().mustChangePassword, false);
  await assert.rejects(client.redeemRecovery(proof, newPassword), {
    code: "proof",
  });
  await client.logout();
});
test("real post-commit audit failure yields uncertain UI state, with fresh-login recovery rather than replay", async (t) => {
  const { f, client } = await fixture(t),
    email = f.data.users[0].email;
  await client.login(email, oldPassword);
  f.beforeAudit = async (event) => {
    if (event.action === "password.changed")
      throw new Error("SYNTHETIC_AUDIT_FAILURE");
  };
  await assert.rejects(client.changeInitialPassword(oldPassword, newPassword), {
    code: "unavailable",
  });
  assert.equal(client.snapshot(), null);
  assert.equal(client.notice, "password-uncertain");
  f.beforeAudit = async () => {};
  await client.login(email, newPassword);
  assert.equal(client.snapshot().mustChangePassword, false);
  await client.logout();
});
