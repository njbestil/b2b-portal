import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  authFixture,
  oldPassword,
} from "../../../api/test/helpers/auth-fixture.mjs";
import { createApp } from "../../../api/dist/app.js";
import { createLogin } from "../../../api/dist/services/login.js";
import { verifyPassword } from "../../../api/dist/infrastructure/passwords.js";
import { createPostgresCancellation } from "../../../api/dist/infrastructure/postgres-cancellation.js";
import { createPostgresCancellationStatus } from "../../../api/dist/infrastructure/postgres-cancellation-status.js";
import { createPostgresCompanyProfiles } from "../../../api/dist/infrastructure/postgres-company-profiles.js";
import { createCancellationStatus } from "../../../api/dist/services/cancellation-status.js";
import { createPostgresRepositories } from "../../../api/dist/infrastructure/postgres-repositories.js";
const opts = {
  skip:
    !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
    "Disposable PostgreSQL URL required",
};
test(
  "actual client and PostgreSQL API persist/read all outcomes, preserve reason privacy and deny foreign/other-user draft reads",
  opts,
  async (t) => {
    const f = await authFixture(t, "postgresql");
    for (let n = 0; n < f.data.users.length; n++)
      await f.setUser({ mustChangePassword: false }, n);
    const company = f.data.companies[0].id;
    await f.pool.query(
      "UPDATE companies SET erp_customer_reference='DEMO-C001' WHERE id=$1",
      [company],
    );
    const decisions = new Map(),
      orders = [];
    for (const outcome of ["unknown", "approved", "rejected"]) {
      const id = randomUUID();
      orders.push(id);
      decisions.set(id, outcome);
      await f.pool.query(
        "INSERT INTO orders(id,company_id,created_by_user_id,order_status,integration_status,erp_order_reference) VALUES($1,$2,$3,'SUBMITTED','SUCCESS',$4)",
        [id, company, f.data.users[2].id, "ERP-" + id],
      );
    }
    const otherDraft = randomUUID();
    await f.pool.query(
      "INSERT INTO orders(id,company_id,created_by_user_id,order_status,integration_status) VALUES($1,$2,$3,'DRAFT','NOT_SENT')",
      [otherDraft, company, f.data.users[3].id],
    );
    const read = createCancellationStatus(
      createPostgresCancellationStatus(f.pool),
      createPostgresCompanyProfiles(f.pool),
    );
    const app = createApp({
      sessions: f.auth,
      sessionLogin: f.auth.login,
      login: createLogin(f.authentication, verifyPassword, f.record),
      companyRepositories: createPostgresRepositories(f.pool),
      cancellationStatus: read,
      orderCancellation: createPostgresCancellation(f.pool, {
        async cancel(input) {
          return {
            outcome: decisions.get(input.orderId) ?? "unknown",
            decidedAt: new Date().toISOString(),
          };
        },
      }),
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
      ),
      { CancellationClient } = await vite.ssrLoadModule(
        "/src/features/cancellations/api.ts",
      );
    const origin = "http://127.0.0.1:" + http.address().port,
      session = new SessionClient(
        (path, init) => fetch(origin + path, init),
        f.now,
      );
    await session.login(f.data.users[2].email, oldPassword);
    const client = new CancellationClient(session, session.snapshot());
    assert.ok(
      (await client.orders(0, new AbortController().signal)).items.some(
        (o) => o.id === orders[0],
      ),
    );
    for (let n = 0; n < orders.length; n++) {
      const id = orders[n],
        key = randomUUID(),
        expected = ["PENDING", "APPROVED", "REJECTED"][n];
      assert.equal(
        (await client.latest(id, new AbortController().signal)).cancellation,
        null,
      );
      const saved = await client.submit(
        id,
        "PRIVATE_SYNTHETIC_REASON",
        key,
        new AbortController().signal,
      );
      assert.equal(saved.cancellation.status, expected);
      assert.deepEqual(
        await client.latest(id, new AbortController().signal),
        saved,
      );
      assert.deepEqual(
        await client.submit(
          id,
          "PRIVATE_SYNTHETIC_REASON",
          key,
          new AbortController().signal,
        ),
        saved,
      );
      assert.ok(!JSON.stringify(saved).includes("PRIVATE"));
    }
    await assert.rejects(
      client.latest(otherDraft, new AbortController().signal),
      { code: "forbidden" },
    );
    await session.login(f.data.users[4].email, oldPassword);
    const foreignProof = await f.login(4);
    const foreign = await fetch(
      origin +
        "/api/v1/companies/" +
        company +
        "/orders/" +
        orders[0] +
        "/cancellations",
      { headers: { authorization: "Bearer " + foreignProof.accessToken } },
    );
    assert.ok([401, 403, 404].includes(foreign.status));
  },
);
