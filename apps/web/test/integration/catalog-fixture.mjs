import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  authFixture,
  oldPassword,
} from "../../../api/test/helpers/auth-fixture.mjs";
import { createApp } from "../../../api/dist/app.js";
import { createApp as createMock } from "../../../mock-erp/dist/app.js";
import { createMockCustomerCatalogSource } from "../../../api/dist/infrastructure/mock-customer-catalog-adapter.js";
import { createCatalogSync } from "../../../api/dist/services/catalog-sync.js";
import { createJsonCatalogCache } from "../../../api/dist/infrastructure/json/catalog-cache.js";
import { createJsonRepositories } from "../../../api/dist/infrastructure/json/repositories.js";
import { JsonFileStore } from "../../../api/dist/infrastructure/json/store.js";
import { seedJson } from "../../../api/dist/demo/seed.js";
import { SessionClient } from "../../src/features/authentication/session.ts";
export async function catalogFixture(t) {
  const f = await authFixture(t, "json");
  assert.ok(resolve(f.directory).startsWith(resolve(tmpdir()) + sep));
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  async function serve(app) {
    const server = app.listen(0, "127.0.0.1");
    server.on("connection", (socket) =>
      socket.on("error", (error) => {
        if (error.code !== "ECONNRESET") throw error;
      }),
    );
    await once(server, "listening");
    t.after(
      () =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
    );
    return `http://127.0.0.1:${server.address().port}`;
  }
  const directory = join(f.directory, "b2b_demo_web_catalog");
  await seedJson(directory, {
    mode: "seed",
    confirmTarget: "b2b_demo_web_catalog",
  });
  const source = createMockCustomerCatalogSource({
    baseUrl: (await serve(createMock())) + "/mock-erp/v1/",
    timeoutMs: 5000,
  });
  await createCatalogSync(
    source,
    createJsonCatalogCache(directory, "b2b_demo_web_catalog", true),
    randomUUID,
  ).synchronize(new AbortController().signal);
  const repositories = createJsonRepositories(
    new JsonFileStore(directory),
    () => new Date(f.now()),
  );
  const origin = await serve(
    createApp({
      login: async () => assert.fail("credential-only fallback"),
      sessionLogin: (input, id) => f.auth.login(input, id),
      sessions: f.auth,
      companyRepositories: repositories,
      logger() {},
    }),
  );
  async function client(index = 2) {
    const client = new SessionClient(
      (path, init) => fetch(origin + path, init),
      f.now,
    );
    await client.login(f.data.users[index].email, oldPassword);
    return client;
  }
  return { f, origin, client };
}
