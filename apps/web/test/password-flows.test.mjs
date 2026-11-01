import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
let server, createPasswordFlows, replacementPasswordError;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  ({ createPasswordFlows, replacementPasswordError } =
    await server.ssrLoadModule("/src/features/authentication/passwords.ts"));
});
after(async () => server?.close());
const password = " Synthetic-new-1! ";
test("production password adapters are unavailable, never synthetic success", async () => {
  const flows = createPasswordFlows();
  await assert.rejects(flows.changeInitialPassword("temporary", password), {
    code: "unavailable",
  });
  await assert.rejects(flows.requestRecovery("admin@example.test"), {
    code: "unavailable",
  });
  await assert.rejects(flows.redeemRecovery("synthetic-proof", password), {
    code: "unavailable",
  });
});
test("explicit test-only producer receives exact password/proof values and fresh-login outcomes are required", async () => {
  const calls = [];
  const flows = createPasswordFlows({
    async changeInitialPassword(input, signal) {
      calls.push({ kind: "change", input, signal });
      return { kind: "password-changed", requiresLogin: true };
    },
    async requestRecovery(input, signal) {
      calls.push({ kind: "request", input, signal });
      return { kind: "received" };
    },
    async redeemRecovery(input, signal) {
      calls.push({ kind: "redeem", input, signal });
      return { kind: "password-changed", requiresLogin: true };
    },
  });
  const signal = new AbortController().signal;
  await flows.changeInitialPassword(" temporary ", password, signal);
  await flows.requestRecovery(" admin@example.test ", signal);
  await flows.redeemRecovery("synthetic-proof", password, signal);
  assert.deepEqual(
    calls.map((c) => c.input),
    [
      { currentPassword: " temporary ", newPassword: password },
      { email: "admin@example.test" },
      { token: "synthetic-proof", newPassword: password },
    ],
  );
  assert.ok(calls.every((c) => c.signal === signal));
});
test("malformed/profiling/automatic-login outcomes and provider failures do not advance workflow", async () => {
  for (const result of [
    undefined,
    { success: true },
    { kind: "password-changed", requiresLogin: false },
    { kind: "session", accessToken: "synthetic" },
  ]) {
    let attempts = 0;
    const flows = createPasswordFlows({
      async changeInitialPassword() {
        attempts++;
        return result;
      },
    });
    await assert.rejects(flows.changeInitialPassword("temporary", password), {
      code: "unavailable",
    });
    assert.equal(attempts, 1);
  }
  const failed = createPasswordFlows({
    async requestRecovery() {
      throw new Error("DO_NOT_RENDER");
    },
  });
  await assert.rejects(
    failed.requestRecovery("admin@example.test"),
    (e) => e.code === "unavailable" && !e.message.includes("DO_NOT_RENDER"),
  );
});
test("cancelled workflows cannot report a successful continuation or retry a credential mutation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const flows = createPasswordFlows({
    async redeemRecovery() {
      calls++;
      controller.abort();
      return { kind: "password-changed", requiresLogin: true };
    },
  });
  await assert.rejects(
    flows.redeemRecovery("synthetic-proof", password, controller.signal),
    { code: "unavailable" },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    flows.redeemRecovery("synthetic-proof", password, controller.signal),
    { code: "unavailable" },
  );
  assert.equal(calls, 1);
});
test("Figma replacement-password validation checks UTF-8 bounds and does not send invalid inputs to producer", async () => {
  assert.equal(replacementPasswordError(password), undefined);
  for (const value of [
    "lowercase1!",
    "NoNumber!",
    "A1!few",
    "A1!" + "🙂".repeat(256),
    "A1!abcde\ud800",
  ])
    assert.ok(replacementPasswordError(value));
  let called = false;
  const flows = createPasswordFlows({
    async changeInitialPassword() {
      called = true;
      return {};
    },
  });
  await assert.rejects(flows.changeInitialPassword("temporary", "weak"), {
    code: "invalid",
  });
  assert.equal(called, false);
});
