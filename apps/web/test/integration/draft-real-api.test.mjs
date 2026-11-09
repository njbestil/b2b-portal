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
import { createOrderDrafts } from "../../../api/dist/services/order-drafts.js";
import { createJsonOrderDrafts } from "../../../api/dist/infrastructure/json/order-drafts.js";
import { createJsonRepositories } from "../../../api/dist/infrastructure/json/repositories.js";

test("real JSON API: draft lifecycle uses canonical versions, exact decimals and explicit deletion", async (t) => {
  const f = await authFixture(t, "json");
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  const app = createApp({
    sessions: f.auth,
    sessionLogin: f.auth.login,
    login: createLogin(f.authentication, verifyPassword, f.record),
    companyRepositories: createJsonRepositories(
      f.security.store,
      () => new Date(f.now()),
    ),
    orderDrafts: createOrderDrafts(
      createJsonOrderDrafts(f.security, f.now),
      f.record,
    ),
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
  const { DraftClient, quantity, meetsMinimum } = await vite.ssrLoadModule(
    "/src/features/order-drafts/api.ts",
  );
  const session = new SessionClient(
    (path, init) =>
      fetch(`http://127.0.0.1:${http.address().port}${path}`, init),
    f.now,
  );
  await session.login(f.data.users[2].email, oldPassword);
  const client = new DraftClient(session, session.snapshot());
  const draft = await client.create();
  assert.ok((await client.list(0)).drafts.some((d) => d.id === draft.id));
  let basket = await client.read(draft.id);
  const product = f.data.products[2];
  assert.equal(meetsMinimum("0.126", "0.125"), true);
  assert.equal(quantity("1e3"), false);
  assert.equal(quantity("1.0000001"), false);
  basket = await client.add(basket, product.id, "0.126000");
  assert.equal(basket.items[0].quantity, "0.126");
  const stale = basket;
  basket = await client.update(basket, basket.items[0], "0.127");
  assert.notEqual(basket.draft.version, stale.draft.version);
  await assert.rejects(client.remove(stale, stale.items[0]), {
    code: "conflict",
  });
  await assert.rejects(client.delete(basket), { code: "conflict" });
  basket = await client.read(draft.id);
  basket = await client.remove(basket, basket.items[0]);
  assert.equal(basket.items.length, 0);
  await client.delete(basket);
  await assert.rejects(client.read(draft.id), { code: "not-found" });
});
