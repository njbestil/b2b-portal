import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { authFixture, barrier } from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createAdminCompanies } from "../dist/services/admin-companies.js";
import { createJsonAdminCompanies } from "../dist/infrastructure/json/admin-companies.js";
import { createPostgresAdminCompanies } from "../dist/infrastructure/postgres-admin-companies.js";
import { createAccountStatus } from "../dist/services/account-status.js";
import { createJsonAccountStatus } from "../dist/infrastructure/json/account-status.js";
import { createPostgresAccountStatus } from "../dist/infrastructure/postgres-account-status.js";
import { createApp } from "../dist/app.js";
const denied = (e) =>
  ["forbidden", "invalid_proof", "restricted"].includes(e.code) ||
  e.name === "AuthorizationError";
async function fixture(t, provider) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.repo =
    provider === "json"
      ? createJsonAdminCompanies(f.security, f.now)
      : createPostgresAdminCompanies(f.pool, f.now);
  f.list = createAdminCompanies(f.repo);
  f.status = createAccountStatus(
    provider === "json"
      ? createJsonAccountStatus(f.security, f.now)
      : createPostgresAccountStatus(f.pool, f.now),
    f.record,
  );
  f.actor = async (i = 0) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(i)).accessToken,
      "profile.read",
    );
  return f;
}
async function serve(t, f) {
  const server = createApp({
    sessions: f.auth,
    adminCompanies: f.repo,
    accountStatus: f.status,
    logger: () => {},
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}/api/v1/admin/companies`;
}
const get = (url, token) =>
  fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const patch = (url, token, body) =>
  fetch(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
  };
  test(
    `${provider}: directory covers every lifecycle state with stable pages, totals and explicit privacy`,
    options,
    async (t) => {
      const f = await fixture(t, provider),
        actor = await f.actor();
      const statuses = [
        "PENDING",
        "ACTIVE",
        "SUSPENDED",
        "REJECTED",
        "DEACTIVATED",
      ];
      const rows = statuses.map((status, i) => ({
        ...f.data.companies[0],
        id: `f0000000-0000-4000-8000-00000000000${i}`,
        legalName: "Identical name",
        status,
        erpCustomerReference: `SYN-${i}`,
      }));
      if (provider === "json")
        await f.security.store.replace("companies", [
          ...f.data.companies,
          ...rows,
        ]);
      else
        for (const c of rows)
          await f.pool.query(
            "INSERT INTO companies(id,legal_name,trade_name,status,erp_customer_reference) VALUES($1,$2,$3,$4,$5)",
            [c.id, c.legalName, c.tradeName, c.status, c.erpCustomerReference],
          );
      const all = await f.list(actor, { offset: 0, limit: 100 });
      assert.equal(all.total, 7);
      assert.deepEqual(
        all.items.map((c) => c.id),
        all.items.map((c) => c.id).sort(),
      );
      assert.deepEqual(
        new Set(all.items.map((c) => c.status)),
        new Set(statuses),
      );
      for (const row of all.items)
        assert.deepEqual(
          Object.keys(row).sort(),
          [
            "id",
            "legalName",
            "tradeName",
            "status",
            "erpCustomerReference",
          ].sort(),
        );
      assert.deepEqual(
        (await f.list(actor, { offset: 1, limit: 2 })).items,
        all.items.slice(1, 3),
      );
      assert.deepEqual(await f.list(actor, { offset: 100000, limit: 1 }), {
        items: [],
        total: 7,
        offset: 100000,
        limit: 1,
      });
      for (const input of [
        { offset: -1, limit: 1 },
        { offset: 100001, limit: 1 },
        { offset: 0, limit: 101 },
        { offset: 0.1, limit: 1 },
      ])
        await assert.rejects(
          f.list(actor, input),
          (e) => e.code === "invalid_input",
        );
      await assert.rejects(f.list({ ...actor }), denied);
      for (let i = 1; i < 4; i++)
        await assert.rejects(f.list(await f.actor(i)), denied);
    },
  );
  test(
    `${provider}: admitted actor lifecycle, credential, access and session changes fail closed`,
    options,
    async (t) => {
      const f = await fixture(t, provider),
        actor = await f.actor();
      await f.setUser({ status: "SUSPENDED" });
      await assert.rejects(f.list(actor), denied);
      await f.setUser({ status: "ACTIVE", mustChangePassword: true });
      await assert.rejects(f.list(actor), denied);
      await f.setUser({ mustChangePassword: false });
      f.clock.value = Date.parse(actor.accessExpiresAt);
      await assert.rejects(f.list(actor), denied);
      f.clock.value -= 1000;
      if (provider === "json")
        await f.setUser({
          passwordHash: "scrypt-v1$" + "a".repeat(32) + "$" + "b".repeat(64),
        });
      else
        await f.pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
          "scrypt-v1$" + "a".repeat(32) + "$" + "b".repeat(64),
          actor.userId,
        ]);
      await assert.rejects(f.list(actor), denied);
    },
  );
  test(
    `${provider}: HTTP listing, suspension, stale conflict and explicit activation reuse shared audit/session rules`,
    options,
    async (t) => {
      const f = await fixture(t, provider),
        url = await serve(t, f),
        admin = await f.login(),
        customer = await f.login(2),
        id = f.data.companies[0].id;
      assert.equal((await get(url)).status, 401);
      for (let i = 1; i < 4; i++)
        assert.equal(
          (await get(url, (await f.login(i)).accessToken)).status,
          403,
        );
      for (const query of [
        "?role=INTERNAL_ADMIN",
        "?offset=01",
        "?limit=0",
        "?limit=101",
        "?limit=1&limit=2",
        "?offset[x]=1",
        "?offset=100001",
      ]) {
        const r = await get(url + query, admin.accessToken);
        assert.equal(r.status, 400, query);
        assert.equal(
          (await r.json()).error.code,
          "INVALID_ADMIN_COMPANY_QUERY",
        );
      }
      let response = await get(url, admin.accessToken);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).data.total, 2);
      assert.equal(
        (
          await patch(`${url}/${id}/status`, admin.accessToken, {
            expectedStatus: "ACTIVE",
            status: "SUSPENDED",
          })
        ).status,
        200,
      );
      assert.equal((await get(url, admin.accessToken)).status, 200);
      assert.equal(
        (
          await patch(`${url}/${id}/status`, admin.accessToken, {
            expectedStatus: "ACTIVE",
            status: "SUSPENDED",
          })
        ).status,
        409,
      );
      await assert.rejects(
        f.auth.authenticateAccess(customer.accessToken),
        denied,
      );
      assert.equal(
        (
          await patch(`${url}/${id}/status`, admin.accessToken, {
            expectedStatus: "SUSPENDED",
            status: "ACTIVE",
          })
        ).status,
        200,
      );
      await assert.rejects(
        f.auth.authenticateAccess(customer.accessToken),
        denied,
      );
      assert.ok((await f.login(2)).accessToken);
      const list = (await (await get(url, admin.accessToken)).json()).data;
      assert.equal(list.items.find((c) => c.id === id).status, "ACTIVE");
      const events =
        provider === "json"
          ? JSON.parse(
              await fs.readFile(join(f.directory, "audit_logs.json"), "utf8"),
            )
          : (await f.pool.query("SELECT action FROM audit_logs")).rows;
      assert.ok(events.some((e) => e.action === "company.suspended"));
      assert.ok(events.some((e) => e.action === "company.reactivated"));
      await f.auth.revoke(admin.accessToken, randomUUID());
      assert.equal((await get(url, admin.accessToken)).status, 401);
    },
  );
  test(
    `${provider}: unavailable company storage fails closed`,
    options,
    async (t) => {
      const f = await fixture(t, provider),
        actor = await f.actor();
      if (provider === "json")
        await fs.writeFile(join(f.directory, "companies.json"), "{broken");
      else
        await f.pool.query(
          "ALTER TABLE companies RENAME TO companies_unavailable",
        );
      await assert.rejects(f.list(actor), (e) => e.code === "unavailable");
    },
  );
}
test("JSON: queued read rechecks current actor after coordinator wait", async (t) => {
  const f = await fixture(t, "json"),
    actor = await f.actor(),
    entered = barrier(),
    release = barrier();
  const block = f.security.run(async () => {
    entered.resolve();
    await release.promise;
    const rows = await f.security.store.read("users");
    rows[0] = { ...rows[0], status: "SUSPENDED" };
    await f.security.store.replace("users", rows);
  });
  await entered.promise;
  const read = assert.rejects(f.list(actor), denied);
  release.resolve();
  await block;
  await read;
});
test(
  "PostgreSQL: real pool wait cannot extend admitted access expiry",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, "postgresql"),
      actor = await f.actor();
    const holders = await Promise.all(
      Array.from({ length: f.pool.options.max }, () => f.pool.connect()),
    );
    try {
      const read = assert.rejects(f.list(actor), denied);
      for (let i = 0; f.pool.waitingCount === 0 && i < 100; i++) await delay(5);
      assert.equal(f.pool.waitingCount, 1);
      f.clock.value = Date.parse(actor.accessExpiresAt);
      while (holders.length) holders.pop().release();
      await read;
    } finally {
      while (holders.length) holders.pop().release();
    }
  },
);
for (const provider of ["json", "postgresql"])
  test(
    provider +
      ": current role and revoked session override previously admitted admin capability",
    {
      skip:
        provider === "postgresql" &&
        !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
    },
    async (t) => {
      const f = await fixture(t, provider),
        token = (await f.login()).accessToken,
        actor = await createAuthorization(f.auth.authenticateAccess).admit(
          token,
          "profile.read",
        );
      if (provider === "json") await f.setUser({ role: "SALES_STAFF" });
      else
        await f.pool.query("UPDATE users SET role='SALES_STAFF' WHERE id=$1", [
          actor.userId,
        ]);
      await assert.rejects(f.list(actor), denied);
      if (provider === "json") await f.setUser({ role: "INTERNAL_ADMIN" });
      else
        await f.pool.query(
          "UPDATE users SET role='INTERNAL_ADMIN' WHERE id=$1",
          [actor.userId],
        );
      await f.auth.revoke(token, randomUUID());
      await assert.rejects(f.list(actor), denied);
    },
  );
