import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { adminFixture } from "../../../api/test/helpers/admin-ui-fixture.mjs";
import { oldPassword } from "../../../api/test/helpers/auth-fixture.mjs";
async function setup(t, provider) {
  const f = await adminFixture(t, provider),
    vite = await createServer({
      root: fileURLToPath(new URL("../../", import.meta.url)),
      configFile: false,
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    });
  t.after(() => vite.close());
  const { SessionClient } = await vite.ssrLoadModule(
      "/src/features/authentication/session.ts",
    ),
    { AdminClient } = await vite.ssrLoadModule(
      "/src/features/admin-operations/api.ts",
    );
  f.session = new SessionClient((path, init) => fetch(f.url + path, init));
  const user = await f.session.login(f.data.users[0].email, oldPassword);
  f.client = new AdminClient(f.session, user);
  return f;
}
for (const provider of ["json", "postgresql"]) {
  const opts = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "PostgreSQL required"
        : false,
  };
  test(
    `${provider}: real Admin client/session/API lists safely and composes create/assignment/status commands`,
    opts,
    async (t) => {
      const f = await setup(t, provider),
        s = new AbortController().signal,
        companies = await f.client.companies(0, s),
        staff = await f.client.staff(0, s);
      assert.ok(companies.items.length);
      assert.equal(staff.total, 1);
      assert.equal(staff.items[0].id, f.data.users[1].id);
      assert.doesNotMatch(
        JSON.stringify(staff),
        /passwordHash|credential|refreshToken/,
      );
      assert.equal((await f.client.staff(100000, s)).total, 1);
      assert.deepEqual((await f.client.staff(100000, s)).items, []);
      const company = companies.items[0];
      assert.deepEqual(await f.client.company(company.id, s), company);
      assert.equal(await f.client.assignment(company.id, s), null);
      const created = await f.client.createStaff(
        {
          displayName: "Synthetic additional Sales",
          email: `new-${randomUUID()}@example.test`,
          temporaryPassword: oldPassword,
        },
        s,
      );
      assert.equal(created.mustChangePassword, true);
      const assignment = await f.client.assign(company.id, created.id, null, s);
      assert.equal(assignment.salesStaffUserId, created.id);
      assert.equal(
        (await f.client.assignment(company.id, s)).id,
        assignment.id,
      );
      await assert.rejects(
        f.client.assign(company.id, staff.items[0].id, null, s),
      );
      assert.equal(
        await f.client.changeCompany(company.id, "ACTIVE", "SUSPENDED", s),
        "SUSPENDED",
      );
      assert.equal(
        await f.client.status("companies", company.id, s),
        "SUSPENDED",
      );
      await assert.rejects(
        f.client.changeCompany(company.id, "ACTIVE", "SUSPENDED", s),
      );
      assert.equal(
        await f.client.changeCompany(company.id, "SUSPENDED", "ACTIVE", s),
        "ACTIVE",
      );
      assert.equal(
        (await f.client.changeStaff(created.id, "ACTIVE", "DEACTIVATED", s))
          .status,
        "DEACTIVATED",
      );
      assert.equal(
        (await f.client.changeStaff(created.id, "DEACTIVATED", "ACTIVE", s))
          .status,
        "ACTIVE",
      );
      const report = await f.client.diagnostics(s);
      assert.equal(report.storage.provider, provider);
      assert.equal(report.storage.status, "up");
      assert.equal(
        report.database.status,
        provider === "json" ? "not_in_use" : "up",
      );
      assert.equal(report.erp.status, "unconfigured");
      if (provider === "json")
        await assert.rejects(
          f.client.transactions(
            { q: "", status: "", companyId: "", orderId: "" },
            0,
            s,
          ),
        );
      else {
        const page = await f.client.transactions(
          { q: "", status: "FAILED", companyId: company.id, orderId: f.order },
          0,
          s,
        );
        assert.equal(page.total, 1);
        const row = await f.client.transaction(page.items[0].id, s);
        assert.doesNotMatch(
          JSON.stringify(row),
          /PRIVATE|payload|errorMessage|idempotency/,
        );
        await assert.rejects(f.client.retry(row, s));
        assert.equal(f.sends, 0);
        assert.equal((await f.client.transaction(row.id, s)).retryCount, 1);
      }
    },
  );
  test(
    `${provider}: Sales directory endpoint denies other roles, selectors, stale authority and exposes no credentials`,
    opts,
    async (t) => {
      const f = await setup(t, provider),
        s = new AbortController().signal;
      for (const i of [1, 2, 3]) {
        const token = (await f.login(i)).accessToken;
        assert.equal(
          (
            await fetch(f.url + "/api/v1/admin/sales-staff", {
              headers: { Authorization: "Bearer " + token },
            })
          ).status,
          403,
        );
      }
      const token = (await f.login(0)).accessToken;
      for (const query of [
        "?companyId=" + f.data.companies[0].id,
        "?offset=01",
        "?limit=101",
        "?offset=1&offset=2",
      ]) {
        assert.equal(
          (
            await fetch(f.url + "/api/v1/admin/sales-staff" + query, {
              headers: { Authorization: "Bearer " + token },
            })
          ).status,
          400,
        );
      }
      const response = await fetch(f.url + "/api/v1/admin/sales-staff", {
        headers: { Authorization: "Bearer " + token },
      });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.status, 200);
      assert.doesNotMatch(
        JSON.stringify(await response.json()),
        /passwordHash|refreshToken|credentialFingerprint/,
      );
      await f.setUser({ status: "SUSPENDED" }, 0);
      await assert.rejects(f.client.staff(0, s));
    },
  );
}
