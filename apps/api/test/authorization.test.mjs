import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { authFixture } from "./helpers/auth-fixture.mjs";
import {
  createAuthorization,
  requirePermission,
  permissions,
} from "../dist/services/authorization.js";
import { createApplicationReview } from "../dist/services/application-review.js";
import { createJsonApplications } from "../dist/infrastructure/json/applications.js";
import { createPostgresApplications } from "../dist/infrastructure/postgres-applications.js";
import { checkedApplication } from "../dist/services/applications.js";
import { createApp } from "../dist/app.js";
const roles = [
  "INTERNAL_ADMIN",
  "SALES_STAFF",
  "CUSTOMER_ADMIN",
  "CUSTOMER_USER",
];
const expected = {
  "order-drafts.read": roles.slice(2),
  "order-drafts.manage": roles.slice(2),
  "company-profile.read": roles,
  "company-profile.manage": roles.slice(2, 3),
  "delivery-addresses.read": roles,
  "delivery-addresses.manage": roles.slice(2, 3),
  "customer-users.manage": roles.slice(2, 3),
  "accounts.status.read": roles.slice(0, 1),
  "accounts.status.write": roles.slice(0, 1),
  "profile.read": roles,
  "company.read": roles,
  "catalog.read": roles,
  "orders.read": roles,
  "customer-users.read": roles.slice(0, 3),
  "applications.read": roles.slice(0, 1),
  "sales.companies.read": roles.slice(1, 2),
};
const forbidden = (e) => e.name === "AuthorizationError";
test("declared operation/four-role matrix denies unknown permissions/roles and copied profiles by default", async () => {
  for (const role of [...roles, "ROOT", "__proto__"]) {
    const auth = createAuthorization(async () => ({
      userId: randomUUID(),
      sessionId: randomUUID(),
      role,
      companyId: null,
      mustChangePassword: false,
      accessExpiresAt: new Date().toISOString(),
    }));
    for (const permission of [
      ...Object.keys(expected),
      "unknown",
      "toString",
      "__proto__",
    ]) {
      if (expected[permission]?.includes?.(role)) {
        const actor = await auth.admit("synthetic", permission);
        requirePermission(actor, permission);
        assert.equal(Object.isFrozen(actor), true);
        assert.throws(
          () => requirePermission({ ...actor }, permission),
          forbidden,
        );
        assert.throws(
          () =>
            requirePermission(JSON.parse(JSON.stringify(actor)), permission),
          forbidden,
        );
      } else
        await assert.rejects(auth.admit("synthetic", permission), forbidden);
    }
  }
  assert.deepEqual(Object.keys(permissions), Object.keys(expected));
  const review = createApplicationReview({
    pending: () => assert.fail("forged actor reached storage"),
  });
  await assert.rejects(
    review({ role: "INTERNAL_ADMIN" }, randomUUID()),
    forbidden,
  );
});
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
const get = (url, token, extra = {}) =>
  fetch(url, {
    headers: {
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...extra,
    },
  });
async function fixture(t, provider) {
  const f = await authFixture(t, provider);
  f.applications =
    provider === "json"
      ? createJsonApplications(
          f.directory,
          f.security.store,
          undefined,
          f.security,
        )
      : createPostgresApplications(f.pool);
  f.application = checkedApplication({
    companyName: "Synthetic Pending Customer",
    tradeLicenseReference: "RBAC-001",
    businessEmail: "business@example.test",
    phone: "555",
    billingAddress: "Synthetic billing",
    deliveryAddress: "Synthetic delivery",
    administratorName: "Synthetic applicant",
    administratorEmail: "applicant@example.test",
    administratorMobile: "556",
    companyId: randomUUID(),
    administratorUserId: randomUUID(),
    deliveryAddressId: randomUUID(),
    createdAt: new Date(f.now()).toISOString(),
    passwordHash: f.passwordHash,
  });
  await f.applications.submit(f.application);
  return f;
}
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
  };
  test(
    provider +
      ": real session principal enforces all role reads and Internal Admin-only application read without credentials",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        logs = [];
      for (let n = 0; n < f.data.users.length; n++)
        await f.setUser({ mustChangePassword: false }, n);
      const url = await serve(t, {
        sessions: f.auth,
        pendingApplication: f.applications.pending,
        logger: (level, event) => logs.push({ level, event }),
      });
      for (const role of roles) {
        const index = f.data.users.findIndex((u) => u.role === role);
        assert.ok(index >= 0);
        const login = await f.login(index),
          auth = createAuthorization(f.auth.authenticateAccess);
        for (const permission of Object.keys(expected)) {
          if (expected[permission].includes(role))
            requirePermission(
              await auth.admit(login.accessToken, permission),
              permission,
            );
          else
            await assert.rejects(
              auth.admit(login.accessToken, permission),
              forbidden,
            );
        }
        const me = await get(url + "/api/v1/auth/me", login.accessToken, {
          "x-role": "INTERNAL_ADMIN",
          "x-company-id": randomUUID(),
        });
        assert.equal(me.status, 200);
        assert.equal((await me.json()).data.user.role, role);
        const response = await get(
          url + "/api/v1/admin/applications/" + f.application.companyId,
          login.accessToken,
          { "x-role": "INTERNAL_ADMIN" },
        );
        assert.equal(response.status, role === "INTERNAL_ADMIN" ? 200 : 403);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const body = await response.json();
        if (role === "INTERNAL_ADMIN") {
          assert.equal(
            body.data.application.companyId,
            f.application.companyId,
          );
          assert.equal(
            body.data.application.administratorEmail,
            f.application.administratorEmail,
          );
        } else assert.equal(body.error.code, "FORBIDDEN");
        const text = JSON.stringify({ body, logs });
        for (const value of [
          login.accessToken,
          login.refreshToken,
          f.passwordHash,
          "passwordHash",
          "credentialFingerprint",
        ])
          assert.equal(text.includes(value), false);
      }
    },
  );
  test(
    provider +
      ": unauthenticated/restricted/revoked/expired/inactive actors and spoofed headers cannot bypass the guard",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        url = await serve(t, {
          sessions: f.auth,
          pendingApplication: f.applications.pending,
          logger: () => {},
        }),
        path = url + "/api/v1/admin/applications/" + f.application.companyId;
      const restricted = await f.login();
      const response = await get(path, restricted.accessToken, {
        "x-role": "INTERNAL_ADMIN",
      });
      assert.equal(response.status, 403);
      assert.equal(
        (await response.json()).error.code,
        "PASSWORD_CHANGE_REQUIRED",
      );
      assert.equal(
        (
          await get(path, undefined, {
            "x-role": "INTERNAL_ADMIN",
            "x-user-id": f.data.users[0].id,
          })
        ).status,
        401,
      );
      assert.equal((await get(path, "invalid")).status, 401);
      await f.setUser({ mustChangePassword: false });
      const login = await f.login();
      assert.equal((await get(path, login.accessToken)).status, 200);
      assert.equal(
        (await get(path + "?companyId=" + randomUUID(), login.accessToken))
          .status,
        400,
      );
      assert.equal(
        (
          await get(
            url + "/api/v1/admin/applications/" + randomUUID(),
            login.accessToken,
          )
        ).status,
        404,
      );
      f.clock.value += 931000;
      assert.equal((await get(path, login.accessToken)).status, 401);
      f.clock.value -= 931000;
      await f.auth.revoke(login.accessToken, randomUUID());
      assert.equal((await get(path, login.accessToken)).status, 401);
      const active = await f.login();
      await f.setUser({ status: "SUSPENDED" });
      assert.equal((await get(path, active.accessToken)).status, 401);
    },
  );
  test(
    provider +
      ": backend role changes take effect on the next request and storage failure is safe 503 before object read",
    options,
    async (t) => {
      const f = await fixture(t, provider);
      await f.setUser({ mustChangePassword: false });
      const login = await f.login(),
        logs = [];
      let reads = 0;
      const url = await serve(t, {
        sessions: f.auth,
        pendingApplication: async (id) => {
          reads++;
          return f.applications.pending(id);
        },
        logger: (level, event) => logs.push({ level, event }),
      });
      const path =
        url + "/api/v1/admin/applications/" + f.application.companyId;
      assert.equal((await get(path, login.accessToken)).status, 200);
      assert.equal(reads, 1);
      if (provider === "json") await f.setUser({ role: "SALES_STAFF" });
      else
        await f.pool.query("UPDATE users SET role='SALES_STAFF' WHERE id=$1", [
          login.user.id,
        ]);
      const denied = await get(path, login.accessToken, {
        "x-role": "INTERNAL_ADMIN",
      });
      assert.equal(denied.status, 403);
      assert.equal(reads, 1);
      assert.equal(
        (await (await get(url + "/api/v1/auth/me", login.accessToken)).json())
          .data.user.role,
        "SALES_STAFF",
      );
      if (provider === "json")
        await writeFile(
          join(f.directory, "users.json"),
          "PRIVATE_STORAGE_ERROR",
        );
      else await f.pool.query("DROP TABLE users CASCADE");
      const failure = await get(path, login.accessToken);
      assert.equal(failure.status, 503);
      assert.equal((await failure.json()).error.code, "AUTH_UNAVAILABLE");
      assert.equal(reads, 1);
      assert.equal(JSON.stringify(logs).includes("PRIVATE"), false);
      assert.equal(JSON.stringify(logs).includes(login.accessToken), false);
    },
  );
}
test("configured business route fails closed without producer/capability and public intake keeps its separate scope", async (t) => {
  const url = await serve(t, { logger: () => {} });
  assert.equal((await get(url + "/api/v1/auth/me")).status, 503);
  assert.equal(
    (await get(url + "/api/v1/admin/applications/" + randomUUID())).status,
    503,
  );
  const principal = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    companyId: null,
    role: "INTERNAL_ADMIN",
    mustChangePassword: false,
    accessExpiresAt: new Date().toISOString(),
  };
  const guarded = await serve(t, {
    sessions: { authenticateAccess: async () => principal },
    logger: () => {},
  });
  assert.equal(
    (
      await get(
        guarded + "/api/v1/admin/applications/" + randomUUID(),
        "synthetic",
      )
    ).status,
    503,
  );
});
