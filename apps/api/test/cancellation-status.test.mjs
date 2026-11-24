import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { authFixture } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createPostgresCancellationStatus } from "../dist/infrastructure/postgres-cancellation-status.js";
import { createPostgresCompanyProfiles } from "../dist/infrastructure/postgres-company-profiles.js";
import { createCancellationStatus } from "../dist/services/cancellation-status.js";
import { createApp } from "../dist/app.js";
const opts = {
  skip:
    !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
    "Disposable PostgreSQL URL required",
};
test(
  "status reads recheck current authority after the scoped read and reject copied actors",
  opts,
  async (t) => {
    const f = await authFixture(t, "postgresql");
    await f.setUser({ mustChangePassword: false }, 2);
    const actor = await createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(2)).accessToken,
      "orders.cancel",
    );
    const company = f.data.companies[0].id,
      order = randomUUID();
    await f.pool.query(
      "INSERT INTO orders(id,company_id,created_by_user_id,order_status,integration_status) VALUES($1,$2,$3,'SUBMITTED','SUCCESS')",
      [order, company, actor.userId],
    );
    const repo = createPostgresCancellationStatus(f.pool),
      profiles = createPostgresCompanyProfiles(f.pool);
    const read = createCancellationStatus(
      {
        async latest(...args) {
          const result = await repo.latest(...args);
          await f.pool.query(
            "UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE id=$1",
            [actor.sessionId],
          );
          return result;
        },
      },
      profiles,
    );
    await assert.rejects(
      read({ ...actor }, company, order, new AbortController().signal),
      (e) => e.name === "AuthorizationError",
    );
    await assert.rejects(
      read(actor, company, order, new AbortController().signal),
      (e) => e.code === "invalid_proof",
    );
  },
);
test(
  "read projection rejects malformed stored status without exposing storage fields",
  opts,
  async (t) => {
    const f = await authFixture(t, "postgresql");
    await f.setUser({ mustChangePassword: false }, 2);
    const actor = await createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(2)).accessToken,
      "orders.cancel",
    );
    for (const cancellation of [
      { requestId: "bad", orderId: randomUUID(), status: "PENDING" },
      { requestId: randomUUID(), status: "PRIVATE_ERROR" },
    ]) {
      const order = randomUUID(),
        read = createCancellationStatus(
          {
            async latest() {
              return {
                createdByUserId: actor.userId,
                orderStatus: "SUBMITTED",
                cancellation: { orderId: order, ...cancellation },
              };
            },
          },
          createPostgresCompanyProfiles(f.pool),
        );
      await assert.rejects(
        read(actor, actor.companyId, order, new AbortController().signal),
        (e) => e.code === "unavailable" && !e.message.includes("PRIVATE"),
      );
    }
  },
);
test("JSON cancellation status remains unavailable with authenticated safe no-store errors", async (t) => {
  const f = await authFixture(t, "json");
  await f.setUser({ mustChangePassword: false }, 2);
  const proof = await f.login(2),
    app = createApp({ sessions: f.auth, logger() {} }),
    http = app.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(resolve);
      }),
  );
  const response = await fetch(
    "http://127.0.0.1:" +
      http.address().port +
      "/api/v1/companies/" +
      f.data.companies[0].id +
      "/orders/" +
      randomUUID() +
      "/cancellations",
    { headers: { authorization: "Bearer " + proof.accessToken } },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).error.code, "CANCELLATION_UNAVAILABLE");
});
