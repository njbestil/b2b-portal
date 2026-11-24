import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  authFixture,
  oldPassword,
} from "../../../api/test/helpers/auth-fixture.mjs";
import { createApp } from "../../../api/dist/app.js";
import { createLogin } from "../../../api/dist/services/login.js";
import { verifyPassword } from "../../../api/dist/infrastructure/passwords.js";
import { createJsonRepositories } from "../../../api/dist/infrastructure/json/repositories.js";
test("real customer API projects processing delays, terminal state and tenant isolation without exposing private fields", async (t) => {
  const f = await authFixture(t, "json");
  for (let n = 0; n < f.data.users.length; n++)
    await f.setUser({ mustChangePassword: false }, n);
  const orders = f.data.orders.map((o, n) => ({
    ...o,
    status: n === 0 ? "DRAFT" : n === 1 ? "SUBMITTED" : "DELIVERED",
    integrationStatus: "FAILED",
    error: "PRIVATE_PROVIDER_MESSAGE",
  }));
  await f.security.store.replace("orders", orders);
  const app = createApp({
    sessions: f.auth,
    sessionLogin: f.auth.login,
    login: createLogin(f.authentication, verifyPassword, f.record),
    companyRepositories: createJsonRepositories(f.security.store),
    logger() {},
  });
  const http = app.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(resolve);
      }),
  );
  const vite = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  t.after(() => vite.close());
  const { SessionClient } = await vite.ssrLoadModule(
    "/src/features/authentication/session.ts",
  );
  const { ProcessingClient } = await vite.ssrLoadModule(
    "/src/features/order-processing/api.ts",
  );
  const session = new SessionClient(
    (path, init) =>
      fetch("http://127.0.0.1:" + http.address().port + path, init),
    f.now,
  );
  await session.login(f.data.users[2].email, oldPassword);
  const a = await new ProcessingClient(session, session.snapshot()).list(
    0,
    new AbortController().signal,
  );
  assert.equal(a.total, 1);
  assert.equal(a.items[0].state.title, "Processing delayed");
  assert.ok(!JSON.stringify(a).includes("PRIVATE"));
  await session.login(f.data.users[4].email, oldPassword);
  const b = await new ProcessingClient(session, session.snapshot()).list(
    0,
    new AbortController().signal,
  );
  assert.equal(b.total, 1);
  assert.equal(b.items[0].state.title, "Delivered");
  assert.notEqual(a.items[0].id, b.items[0].id);
});
