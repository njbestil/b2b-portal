import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  authFixture,
  oldPassword,
  newPassword,
  barrier,
} from "./helpers/auth-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createAdminSalesAssignments } from "../dist/services/admin-sales-assignments.js";
import { createJsonAdminSalesAssignments } from "../dist/infrastructure/json/admin-sales-assignments.js";
import { createPostgresAdminSalesAssignments } from "../dist/infrastructure/postgres-admin-sales-assignments.js";
import { createJsonSalesAssignments } from "../dist/infrastructure/json/sales-assignments.js";
import { createPostgresSalesAssignments } from "../dist/infrastructure/postgres-sales-assignments.js";
import { createSalesStaff } from "../dist/services/sales-staff.js";
import { createJsonSalesStaff } from "../dist/infrastructure/json/sales-staff.js";
import { createPostgresSalesStaff } from "../dist/infrastructure/postgres-sales-staff.js";
import { JsonSecurityCoordinator } from "../dist/infrastructure/json/security.js";
import { createApp } from "../dist/app.js";
const code = (value) => (e) => e.code === value;
const denied = (e) =>
  ["invalid_proof", "restricted", "forbidden"].includes(e.code) ||
  e.name === "AuthorizationError";
async function fixture(t, provider = "json", io = fs) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  f.patchUser = async (id, patch) => {
    if (provider === "json")
      await f.security.run(async () =>
        f.security.store.replace(
          "users",
          (await f.security.store.read("users")).map((u) =>
            u.id === id ? { ...u, ...patch } : u,
          ),
        ),
      );
    else {
      const columns = {
        role: "role",
        status: "status",
        companyId: "company_id",
        mustChangePassword: "must_change_password",
        passwordHash: "password_hash",
      };
      for (const [k, v] of Object.entries(patch))
        await f.pool.query(`UPDATE users SET ${columns[k]}=$1 WHERE id=$2`, [
          v,
          id,
        ]);
    }
  };
  f.addUser = async (role, email) => {
    const row = {
      ...f.data.users[1],
      id: randomUUID(),
      email,
      role,
      mustChangePassword: false,
    };
    f.data.users.push(row);
    if (provider === "json")
      await f.security.run(async () =>
        f.security.store.replace("users", [
          ...(await f.security.store.read("users")),
          row,
        ]),
      );
    else
      await f.pool.query(
        "INSERT INTO users(id,email,password_hash,display_name,role,status,must_change_password) VALUES($1,$2,$3,$4,$5,'ACTIVE',false)",
        [row.id, email, f.passwordHash, row.displayName, role],
      );
    return row;
  };
  f.second = await f.addUser("SALES_STAFF", "second@example.test");
  f.third = await f.addUser("SALES_STAFF", "third@example.test");
  f.otherAdmin = await f.addUser("INTERNAL_ADMIN", "other-admin@example.test");
  f.repo =
    provider === "json"
      ? createJsonAdminSalesAssignments(f.security, f.now, io)
      : createPostgresAdminSalesAssignments(f.pool, f.now);
  f.service = (repo) =>
    createAdminSalesAssignments(repo ?? f.repo, f.record, randomUUID);
  f.manage = f.service();
  f.actor = async (i = 0) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(i)).accessToken,
      "profile.read",
    );
  f.policy =
    provider === "json"
      ? createJsonSalesAssignments(f.security, f.now)
      : createPostgresSalesAssignments(f.pool, f.now);
  f.rows = async () =>
    provider === "json"
      ? JSON.parse(
          await fs
            .readFile(
              join(f.directory, "customer_sales_assignments.json"),
              "utf8",
            )
            .catch((e) => {
              if (e.code === "ENOENT") return "[]";
              throw e;
            }),
        )
      : (
          await f.pool.query(
            'SELECT id,company_id AS "companyId",sales_staff_user_id AS "salesStaffUserId",assigned_by_user_id AS "assignedByUserId",is_primary AS "isPrimary",active,created_at AS "createdAt",ended_at AS "endedAt" FROM customer_sales_assignments ORDER BY created_at,id',
          )
        ).rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          endedAt: r.endedAt?.toISOString() ?? null,
        }));
  f.write = async (rows) => {
    if (provider === "json")
      await fs.writeFile(
        join(f.directory, "customer_sales_assignments.json"),
        JSON.stringify(rows),
      );
    else
      for (const r of rows)
        await f.pool.query(
          "INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            r.id,
            r.companyId,
            r.salesStaffUserId,
            r.assignedByUserId,
            r.isPrimary,
            r.active,
            r.createdAt,
            r.endedAt,
          ],
        );
  };
  f.company = async (status) => {
    if (provider === "json")
      await f.security.run(async () =>
        f.security.store.replace(
          "companies",
          (await f.security.store.read("companies")).map((c, i) =>
            i === 0 ? { ...c, status } : c,
          ),
        ),
      );
    else
      await f.pool.query("UPDATE companies SET status=$1 WHERE id=$2", [
        status,
        f.data.companies[0].id,
      ]);
  };
  f.assignment = (patch = {}) => ({
    id: randomUUID(),
    companyId: f.data.companies[0].id,
    salesStaffUserId: f.data.users[1].id,
    assignedByUserId: f.data.users[0].id,
    active: true,
    isPrimary: true,
    createdAt: new Date(f.now() - 1000).toISOString(),
    endedAt: null,
    ...patch,
  });
  return f;
}
const change = (staff, expectedAssignmentId = null) => ({
  salesStaffUserId: staff,
  expectedAssignmentId,
});
async function serve(t, f, service = f.manage, logs = []) {
  const server = createApp({
    sessions: f.auth,
    adminSalesAssignments: service,
    salesAssignments: f.policy,
    logger: (level, event) => logs.push({ level, event }),
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  return "http://127.0.0.1:" + server.address().port;
}
const path = (company) => `/api/v1/admin/companies/${company}/sales-assignment`;
const request = (url, token, body, headers = {}) =>
  fetch(url, {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function data(response, status = 200) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()).data;
}
for (const provider of ["json", "postgresql"]) {
  const opts = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set disposable B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
  };
  test(
    provider +
      ": HTTP assignment/reassignment preserves history and immediately switches current policy/list access",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        logs = [],
        base = await serve(t, f, f.manage, logs),
        company = f.data.companies[0].id,
        other = f.data.companies[1].id,
        admin = (await f.login()).accessToken,
        url = base + path(company),
        staff = f.data.users[1].id;
      assert.deepEqual(await data(await request(url, admin)), {
        assignment: null,
      });
      const first = (await data(await request(url, admin, change(staff))))
        .assignment;
      assert.deepEqual(
        Object.keys(first).sort(),
        [
          "id",
          "companyId",
          "salesStaffUserId",
          "assignedByUserId",
          "active",
          "isPrimary",
          "createdAt",
          "endedAt",
        ].sort(),
      );
      assert.equal(first.active, true);
      assert.equal(first.isPrimary, true);
      assert.equal(first.endedAt, null);
      assert.equal(first.companyId, company);
      assert.equal(first.assignedByUserId, f.data.users[0].id);
      const oldProof = await f.login(1),
        newProof = await f.login(
          f.data.users.findIndex((u) => u.id === f.second.id),
        );
      const listed = (token) =>
        request(base + "/api/v1/sales/companies", token);
      assert.equal((await data(await listed(oldProof.accessToken))).total, 1);
      assert.equal((await data(await listed(newProof.accessToken))).total, 0);
      const otherAssignment = (
        await f.manage.assign(
          await f.actor(),
          other,
          change(f.third.id),
          randomUUID(),
        )
      ).assignment;
      f.clock.value += 1000;
      const next = (
        await data(await request(url, admin, change(f.second.id, first.id)))
      ).assignment;
      assert.notEqual(next.id, first.id);
      assert.equal(next.salesStaffUserId, f.second.id);
      assert.deepEqual(
        (await data(await request(url, admin))).assignment,
        next,
      );
      assert.equal(await f.policy.allows(staff, company), false);
      assert.equal(await f.policy.allows(f.second.id, company), true);
      assert.equal((await data(await listed(oldProof.accessToken))).total, 0);
      assert.equal((await data(await listed(newProof.accessToken))).total, 1);
      const rows = await f.rows(),
        ended = rows.find((r) => r.id === first.id);
      assert.equal(ended.active, false);
      assert.equal(ended.endedAt, next.createdAt);
      assert.equal(ended.createdAt, first.createdAt);
      assert.equal(ended.salesStaffUserId, staff);
      assert.equal(
        rows.filter((r) => r.companyId === company && r.active && r.isPrimary)
          .length,
        1,
      );
      assert.deepEqual(
        rows.find((r) => r.id === otherAssignment.id),
        otherAssignment,
      );
      const events =
        provider === "json"
          ? JSON.parse(await fs.readFile(join(f.directory, "audit_logs.json")))
          : (await f.pool.query("SELECT action,metadata FROM audit_logs")).rows;
      assert.deepEqual(
        events
          .filter((e) => e.action.startsWith("sales_assignment."))
          .map((e) => e.action),
        [
          "sales_assignment.assigned",
          "sales_assignment.assigned",
          "sales_assignment.reassigned",
        ],
      );
      const text = JSON.stringify({ first, next, events, logs });
      assert.equal(text.includes(f.passwordHash), false);
      assert.equal(text.includes(oldPassword), false);
      assert.equal(
        JSON.stringify(events).includes("second@example.test"),
        false,
      );
    },
  );
  test(
    provider +
      ": competing initial/reassign writes have one winner; same/stale selectors preserve one primary/history",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        a = await f.actor(),
        b = await f.actor(
          f.data.users.findIndex((u) => u.id === f.otherAdmin.id),
        ),
        company = f.data.companies[0].id;
      const race = await Promise.allSettled([
        f.manage.assign(a, company, change(f.data.users[1].id), randomUUID()),
        f.manage.assign(b, company, change(f.second.id), randomUUID()),
      ]);
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        race.find((r) => r.status === "rejected").reason.code,
        "conflict",
      );
      const first = race.find((r) => r.status === "fulfilled").value.assignment;
      await assert.rejects(
        f.manage.assign(
          a,
          company,
          change(first.salesStaffUserId, first.id),
          randomUUID(),
        ),
        code("conflict"),
      );
      await assert.rejects(
        f.manage.assign(a, company, change(f.third.id), randomUUID()),
        code("conflict"),
      );
      const replacement =
        first.salesStaffUserId === f.second.id
          ? f.data.users[1].id
          : f.second.id;
      const racing = await Promise.allSettled([
        f.manage.assign(
          a,
          company,
          change(replacement, first.id),
          randomUUID(),
        ),
        f.manage.assign(b, company, change(f.third.id, first.id), randomUUID()),
      ]);
      assert.equal(racing.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        racing.find((r) => r.status === "rejected").reason.code,
        "conflict",
      );
      const rows = await f.rows();
      assert.equal(rows.length, 2);
      assert.equal(rows.filter((r) => r.active && r.isPrimary).length, 1);
      assert.equal(
        rows.filter((r) => !r.active && r.endedAt !== null).length,
        1,
      );
    },
  );
  test(
    provider +
      ": four-role/capability/shape/target denial and current company/staff eligibility",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        a = await f.actor(),
        company = f.data.companies[0].id,
        staff = f.data.users[1].id;
      for (const i of [1, 2, 3, 4, 5]) {
        const actor = await f.actor(i);
        await assert.rejects(f.manage.current(actor, company), denied);
        await assert.rejects(
          f.manage.assign(actor, company, change(staff), randomUUID()),
          denied,
        );
      }
      await assert.rejects(
        f.manage.assign({ ...a }, company, change(staff), randomUUID()),
        denied,
      );
      for (const body of [
        null,
        [],
        {},
        { salesStaffUserId: staff },
        { ...change(staff), role: "INTERNAL_ADMIN" },
        { ...change(staff), active: false },
        { ...change(staff), assignedByUserId: a.userId },
        { ...change(staff), companyId: company },
        change("bad"),
        change(staff, "bad"),
      ]) {
        await assert.rejects(
          f.manage.assign(a, company, body, randomUUID()),
          code("invalid_input"),
        );
      }
      for (const id of [f.data.users[0].id, f.data.users[2].id, randomUUID()])
        await assert.rejects(
          f.manage.assign(a, company, change(id), randomUUID()),
          code("not_found"),
        );
      await assert.rejects(
        f.manage.assign(a, randomUUID(), change(staff), randomUUID()),
        code("not_found"),
      );
      for (const status of [
        "SUSPENDED",
        "DEACTIVATED",
        "PENDING",
        "REJECTED",
      ]) {
        await f.patchUser(staff, { status });
        await assert.rejects(
          f.manage.assign(a, company, change(staff), randomUUID()),
          code("conflict"),
        );
      }
      await f.patchUser(staff, { status: "ACTIVE" });
      for (const status of ["PENDING", "REJECTED", "DEACTIVATED"]) {
        await f.company(status);
        await assert.rejects(
          f.manage.assign(a, company, change(staff), randomUUID()),
          code("conflict"),
        );
      }
      await f.company("SUSPENDED");
      const assigned = await f.manage.assign(
        a,
        company,
        change(staff),
        randomUUID(),
      );
      assert.equal(await f.policy.allows(staff, company), false);
      const next = await f.manage.assign(
        a,
        company,
        change(f.second.id, assigned.assignment.id),
        randomUUID(),
      );
      assert.equal(next.assignment.salesStaffUserId, f.second.id);
      assert.equal(await f.policy.allows(f.second.id, company), false);
      await f.company("ACTIVE");
      assert.equal(await f.policy.allows(f.second.id, company), true);
    },
  );
  test(
    provider +
      ": create Staff then assign while restricted; first-login change enables fresh access without rewriting assignment",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        a = await f.actor(),
        company = f.data.companies[0].id;
      const staff = createSalesStaff(
        provider === "json"
          ? createJsonSalesStaff(f.security, f.now)
          : createPostgresSalesStaff(f.pool, f.now),
        async () => f.passwordHash,
        f.record,
        randomUUID,
      );
      const created = (
        await staff.create(
          a,
          {
            displayName: "New Sales",
            email: "new-sales@example.test",
            temporaryPassword: oldPassword,
          },
          randomUUID(),
        )
      ).user;
      const assigned = (
        await f.manage.assign(a, company, change(created.id), randomUUID())
      ).assignment;
      assert.equal(await f.policy.allows(created.id, company), false);
      const restricted = await f.auth.login(
        { email: created.email, password: oldPassword },
        randomUUID(),
      );
      await assert.rejects(
        createAuthorization(f.auth.authenticateAccess).admit(
          restricted.accessToken,
          "sales.companies.read",
        ),
        denied,
      );
      await f.change()(
        restricted.accessToken,
        { currentPassword: oldPassword, newPassword },
        randomUUID(),
      );
      await assert.rejects(
        f.auth.authenticateAccess(restricted.accessToken),
        denied,
      );
      const fresh = await f.auth.login(
        { email: created.email, password: newPassword },
        randomUUID(),
      );
      assert.equal(
        (
          await createAuthorization(f.auth.authenticateAccess).admit(
            fresh.accessToken,
            "sales.companies.read",
          )
        ).role,
        "SALES_STAFF",
      );
      assert.equal(await f.policy.allows(created.id, company), true);
      assert.equal(
        (await f.manage.current(a, company)).assignment.id,
        assigned.id,
      );
    },
  );
  test(
    provider +
      ": ending prior primary and secondary evidence preserves all prior rows and yields one active primary",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        a = await f.actor(),
        company = f.data.companies[0].id,
        primary = f.assignment(),
        secondary = f.assignment({
          salesStaffUserId: f.second.id,
          isPrimary: false,
        });
      await f.write([primary, secondary]);
      const result = (
        await f.manage.assign(
          a,
          company,
          change(f.third.id, primary.id),
          randomUUID(),
        )
      ).assignment;
      const rows = await f.rows();
      assert.equal(rows.length, 3);
      for (const id of [primary.id, secondary.id]) {
        const old = rows.find((r) => r.id === id);
        assert.equal(old.active, false);
        assert.equal(old.endedAt, result.createdAt);
      }
      assert.equal(rows.filter((r) => r.active).length, 1);
      assert.equal(await f.policy.allows(f.third.id, company), true);
    },
  );
  test(
    provider +
      ": required audit failure leaves a complete unconfirmed result, safe retry conflicts and GET recovers",
    opts,
    async (t) => {
      const f = await fixture(t, provider),
        a = await f.actor(),
        company = f.data.companies[0].id;
      f.beforeAudit = async (e) => {
        if (e.action.startsWith("sales_assignment."))
          throw Error("PRIVATE_AUDIT");
      };
      await assert.rejects(
        f.manage.assign(a, company, change(f.data.users[1].id), randomUUID()),
        code("unavailable"),
      );
      const current = (await f.manage.current(a, company)).assignment;
      assert.equal(current.salesStaffUserId, f.data.users[1].id);
      assert.equal((await f.rows()).length, 1);
      await assert.rejects(
        f.manage.assign(a, company, change(f.second.id), randomUUID()),
        code("conflict"),
      );
      await assert.rejects(
        f.manage.assign(
          a,
          company,
          change(f.second.id, current.id),
          randomUUID(),
        ),
        code("unavailable"),
      );
      assert.equal((await f.rows()).length, 2);
      assert.equal(await f.policy.allows(f.data.users[1].id, company), false);
      assert.equal(await f.policy.allows(f.second.id, company), true);
    },
  );
}

test("JSON publication failures retain one complete ownership state across reopen, expiry and corrupt-file refusal", async (t) => {
  for (const scenario of [
    "before-first",
    "after-first",
    "before-reassign",
    "after-reassign",
    "expired",
  ]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t),
        a = await f.actor(),
        company = f.data.companies[0].id;
      const first =
        scenario.includes("reassign") || scenario === "expired"
          ? (
              await f.manage.assign(
                a,
                company,
                change(f.data.users[1].id),
                randomUUID(),
              )
            ).assignment
          : null;
      const io = {
        ...fs,
        open: async (...args) => {
          const h = await fs.open(...args);
          if (scenario !== "expired") return h;
          return {
            writeFile: (...x) => h.writeFile(...x),
            sync: async () => {
              await h.sync();
              f.clock.value = Date.parse(a.accessExpiresAt);
            },
            close: () => h.close(),
          };
        },
        rename: async (...args) => {
          if (scenario.startsWith("before")) throw Error("PRIVATE_BEFORE");
          await fs.rename(...args);
          if (scenario.startsWith("after")) throw Error("PRIVATE_AFTER");
        },
      };
      const repo = createJsonAdminSalesAssignments(f.security, f.now, io),
        pending = f
          .service(repo)
          .assign(
            a,
            company,
            change(first ? f.second.id : f.data.users[1].id, first?.id ?? null),
            randomUUID(),
          );
      await assert.rejects(
        pending,
        scenario === "expired" ? denied : code("unavailable"),
      );
      const rows = await f.rows(),
        committed = scenario.startsWith("after");
      assert.equal(rows.length, (first ? 1 : 0) + (committed ? 1 : 0));
      assert.equal(
        rows.filter((r) => r.active && r.isPrimary).length,
        first || committed ? 1 : 0,
      );
      f.clock.value -= scenario === "expired" ? 1000 : 0;
      const reopened = f.service(
        createJsonAdminSalesAssignments(
          new JsonSecurityCoordinator(f.directory),
          f.now,
        ),
      );
      const current = (await reopened.current(a, company)).assignment;
      assert.equal(
        current?.salesStaffUserId ?? null,
        committed
          ? first
            ? f.second.id
            : f.data.users[1].id
          : (first?.salesStaffUserId ?? null),
      );
      assert.equal(
        (await fs.readdir(f.directory)).some((n) =>
          n.startsWith(".customer_sales_assignments."),
        ),
        false,
      );
    });
  }
  const f = await fixture(t),
    a = await f.actor(),
    company = f.data.companies[0].id,
    path = join(f.directory, "customer_sales_assignments.json");
  for (const text of [
    "{",
    JSON.stringify([f.assignment(), f.assignment()]),
    JSON.stringify([f.assignment({ salesStaffUserId: randomUUID() })]),
  ]) {
    await fs.writeFile(path, text);
    await assert.rejects(f.manage.current(a, company), code("unavailable"));
    await assert.rejects(
      f.manage.assign(a, company, change(f.second.id), randomUUID()),
      code("unavailable"),
    );
    assert.equal(await fs.readFile(path, "utf8"), text);
  }
});

test("JSON queued mutations recheck current actor/session/company/staff before publishing", async (t) => {
  for (const scenario of [
    "actor-role",
    "actor-inactive",
    "actor-restricted",
    "actor-credential",
    "revoked",
    "expiry",
    "staff-inactive",
    "company-pending",
  ]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t),
        a = await f.actor(),
        company = f.data.companies[0].id,
        entered = barrier(),
        release = barrier();
      const holding = f.security.run(async () => {
        entered.resolve();
        await release.promise;
        if (scenario.startsWith("actor") || scenario === "staff-inactive") {
          const id =
              scenario === "staff-inactive" ? f.data.users[1].id : a.userId,
            patch =
              scenario === "actor-role"
                ? { role: "SALES_STAFF" }
                : scenario === "actor-restricted"
                  ? { mustChangePassword: true }
                  : scenario === "actor-credential"
                    ? {
                        passwordHash:
                          "scrypt-v1$" + "1".repeat(32) + "$" + "2".repeat(64),
                      }
                    : { status: "SUSPENDED" };
          await f.security.store.replace(
            "users",
            (await f.security.store.read("users")).map((u) =>
              u.id === id ? { ...u, ...patch } : u,
            ),
          );
        }
        if (scenario === "revoked") {
          const file = join(f.directory, "user_sessions.json"),
            rows = JSON.parse(await fs.readFile(file, "utf8"));
          await fs.writeFile(
            file,
            JSON.stringify(
              rows.map((r) =>
                r.id === a.sessionId
                  ? { ...r, revokedAt: new Date(f.now()).toISOString() }
                  : r,
              ),
            ),
          );
        }
        if (scenario === "expiry")
          f.clock.value = Date.parse(a.accessExpiresAt);
        if (scenario === "company-pending")
          await f.security.store.replace(
            "companies",
            (await f.security.store.read("companies")).map((c) =>
              c.id === company ? { ...c, status: "PENDING" } : c,
            ),
          );
      });
      await entered.promise;
      const pending = f.manage.assign(
        a,
        company,
        change(f.data.users[1].id),
        randomUUID(),
      );
      release.resolve();
      await holding;
      await assert.rejects(
        pending,
        ["staff-inactive", "company-pending"].includes(scenario)
          ? code("conflict")
          : denied,
      );
      assert.deepEqual(await f.rows(), []);
    });
  }
});

for (const provider of ["json", "postgresql"])
  test(
    provider +
      ": Staff deactivation racing assignment never leaves inactive Staff with effective access",
    {
      skip:
        provider === "postgresql" &&
        !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
    },
    async (t) => {
      const f = await fixture(t, provider),
        a = await f.actor(),
        b = await f.actor(
          f.data.users.findIndex((u) => u.id === f.otherAdmin.id),
        ),
        company = f.data.companies[0].id,
        staff = f.data.users[1].id;
      const lifecycle = createSalesStaff(
        provider === "json"
          ? createJsonSalesStaff(f.security, f.now)
          : createPostgresSalesStaff(f.pool, f.now),
        async () => f.passwordHash,
        f.record,
        randomUUID,
      );
      const results = await Promise.allSettled([
        f.manage.assign(a, company, change(staff), randomUUID()),
        lifecycle.change(
          b,
          staff,
          { expectedStatus: "ACTIVE" },
          "DEACTIVATED",
          randomUUID(),
        ),
      ]);
      assert.equal(results[1].status, "fulfilled");
      if (results[0].status === "rejected")
        assert.equal(results[0].reason.code, "conflict");
      assert.equal(await f.policy.allows(staff, company), false);
      const rows = await f.rows();
      assert.equal(
        rows.filter((r) => r.active && r.isPrimary).length,
        results[0].status === "fulfilled" ? 1 : 0,
      );
    },
  );

test(
  "SQL real company/user/assignment lock waits recheck current eligibility and access expiry; failed insert rolls back ending history",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    for (const scenario of [
      "expiry-company",
      "expiry-assignment",
      "actor-role",
      "actor-inactive",
      "actor-credential",
      "revoked",
      "staff-inactive",
      "company-pending",
    ]) {
      await t.test(scenario, async (t) => {
        const f = await fixture(t, "postgresql"),
          a = await f.actor(),
          company = f.data.companies[0].id,
          staff = f.data.users[1].id,
          blocker = await f.pool.connect();
        let first = null;
        if (scenario === "expiry-assignment")
          first = (
            await f.manage.assign(a, company, change(f.second.id), randomUUID())
          ).assignment;
        await blocker.query("BEGIN");
        if (scenario === "expiry-assignment")
          await blocker.query(
            "SELECT id FROM customer_sales_assignments WHERE id=$1 FOR UPDATE",
            [first.id],
          );
        else if (scenario.startsWith("actor"))
          await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            a.userId,
          ]);
        else if (scenario === "staff-inactive")
          await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            staff,
          ]);
        else if (scenario === "revoked")
          await blocker.query(
            "SELECT id FROM user_sessions WHERE id=$1 FOR UPDATE",
            [a.sessionId],
          );
        else
          await blocker.query(
            "SELECT id FROM companies WHERE id=$1 FOR UPDATE",
            [company],
          );
        const pending = f.manage.assign(
          a,
          company,
          change(staff, first?.id ?? null),
          randomUUID(),
        );
        try {
          let waiting = false;
          for (let i = 0; i < 100; i++) {
            const r = await f.admin.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND (query LIKE '%users%' OR query LIKE '%companies%' OR query LIKE '%user_sessions%' OR query LIKE '%customer_sales_assignments%')",
            );
            if (r.rows[0].n > 0) {
              waiting = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.equal(waiting, true);
          if (scenario.startsWith("expiry"))
            f.clock.value = Date.parse(a.accessExpiresAt);
          if (scenario === "actor-role")
            await blocker.query(
              "UPDATE users SET role='SALES_STAFF' WHERE id=$1",
              [a.userId],
            );
          if (scenario === "actor-inactive")
            await blocker.query(
              "UPDATE users SET status='SUSPENDED' WHERE id=$1",
              [a.userId],
            );
          if (scenario === "actor-credential")
            await blocker.query(
              "UPDATE users SET password_hash=$1 WHERE id=$2",
              ["scrypt-v1$" + "1".repeat(32) + "$" + "2".repeat(64), a.userId],
            );
          if (scenario === "revoked")
            await blocker.query(
              "UPDATE user_sessions SET revoked_at=$1 WHERE id=$2",
              [new Date(f.now()).toISOString(), a.sessionId],
            );
          if (scenario === "staff-inactive")
            await blocker.query(
              "UPDATE users SET status='DEACTIVATED' WHERE id=$1",
              [staff],
            );
          if (scenario === "company-pending")
            await blocker.query(
              "UPDATE companies SET status='PENDING' WHERE id=$1",
              [company],
            );
          await blocker.query("COMMIT");
          await assert.rejects(
            pending,
            scenario === "actor-role"
              ? code("forbidden")
              : ["staff-inactive", "company-pending"].includes(scenario)
                ? code("conflict")
                : denied,
          );
          assert.equal((await f.rows()).length, first ? 1 : 0);
          if (first) assert.equal((await f.rows())[0].active, true);
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
      });
    }
    const f = await fixture(t, "postgresql"),
      a = await f.actor(),
      company = f.data.companies[0].id,
      first = (
        await f.manage.assign(
          a,
          company,
          change(f.data.users[1].id),
          randomUUID(),
        )
      ).assignment;
    await f.pool.query(
      "CREATE FUNCTION refuse_assignment_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_INSERT'; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER refuse_assignment_insert BEFORE INSERT ON customer_sales_assignments FOR EACH ROW EXECUTE FUNCTION refuse_assignment_insert()",
    );
    await assert.rejects(
      f.manage.assign(a, company, change(f.second.id, first.id), randomUUID()),
      code("unavailable"),
    );
    assert.deepEqual(await f.rows(), [first]);
    assert.equal(await f.policy.allows(first.salesStaffUserId, company), true);
  },
);

test("HTTP validates role/session/selectors/body/media/size, bounds attempts/capacity and hides provider failures", async (t) => {
  const f = await fixture(t),
    logs = [],
    base = await serve(t, f, f.manage, logs),
    company = f.data.companies[0].id,
    url = base + path(company),
    admin = (await f.login()).accessToken,
    body = change(f.data.users[1].id);
  assert.equal((await request(url, null, body)).status, 401);
  for (const i of [1, 2, 3]) {
    const token = (await f.login(i)).accessToken;
    assert.equal(
      (await request(url, token, body, { "x-role": "INTERNAL_ADMIN" })).status,
      403,
    );
    assert.equal((await request(url, token)).status, 403);
  }
  for (const suffix of ["?role=INTERNAL_ADMIN", "?companyId=x"]) {
    assert.equal((await request(url + suffix, admin, body)).status, 400);
    assert.equal((await request(url + suffix, admin)).status, 400);
  }
  assert.equal(
    (await request(url, admin, { ...body, active: true })).status,
    400,
  );
  assert.equal(
    (await request(url, admin, body, { "content-type": "text/plain" })).status,
    415,
  );
  assert.equal(
    (await request(url, admin, { ...body, padding: "x".repeat(5000) })).status,
    413,
  );
  const malformed = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: "Bearer " + admin,
      "content-type": "application/json",
    },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  let limited;
  for (let i = 0; i < 5; i++) limited = await request(url, admin, {});
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  const failure = await serve(
    t,
    f,
    f.service({
      current: async () => {
        throw Error("PRIVATE_READ");
      },
      assign: async () => {
        throw Error("PRIVATE_WRITE");
      },
    }),
  );
  for (const value of [undefined, body]) {
    const r = await request(failure + path(company), admin, value);
    assert.equal(r.status, 503);
    assert.equal((await r.text()).includes("PRIVATE"), false);
  }
  const entered = barrier(),
    release = barrier();
  let count = 0;
  const blocking = await serve(
    t,
    f,
    f.service({
      current: f.repo.current,
      assign: async (a, input) => {
        if (++count === 4) entered.resolve();
        await release.promise;
        return f.repo.assign(a, input);
      },
    }),
  );
  const pending = Array.from({ length: 4 }, () =>
    request(blocking + path(company), admin, body),
  );
  await entered.promise;
  assert.equal(
    (await request(blocking + path(company), admin, body)).status,
    503,
  );
  release.resolve();
  const statuses = (await Promise.all(pending)).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 200).length, 1);
  assert.equal(statuses.filter((s) => s === 409).length, 3);
  assert.equal(JSON.stringify(logs).includes(oldPassword), false);
  assert.equal(JSON.stringify(logs).includes("PRIVATE"), false);
});

test(
  "SQL history capacity refuses reassignment before publishing an unreadable row10001 and preserves current owner",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, "postgresql"),
      a = await f.actor(),
      company = f.data.companies[0].id;
    await f.pool.query(
      "INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at,ended_at) SELECT ('a8400000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,$1,$2,$3,true,false,$4,$4 FROM generate_series(1,9999) n",
      [
        company,
        f.data.users[1].id,
        a.userId,
        new Date(f.now() - 1000).toISOString(),
      ],
    );
    const first = (
      await f.manage.assign(
        a,
        company,
        change(f.data.users[1].id),
        randomUUID(),
      )
    ).assignment;
    assert.equal((await f.rows()).length, 10000);
    await assert.rejects(
      f.manage.assign(a, company, change(f.second.id, first.id), randomUUID()),
      code("unavailable"),
    );
    const rows = await f.rows();
    assert.equal(rows.length, 10000);
    assert.equal(rows.filter((r) => r.active && r.isPrimary).length, 1);
    assert.equal(rows.find((r) => r.id === first.id).active, true);
    assert.equal((await f.manage.current(a, company)).assignment.id, first.id);
    assert.equal(await f.policy.allows(first.salesStaffUserId, company), true);
  },
);
