import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { adminFixture } from "./helpers/admin-ui-fixture.mjs";
import { createAuthorization } from "../dist/services/authorization.js";
import { createOrderDrafts } from "../dist/services/order-drafts.js";
import { createPostgresOrderDrafts } from "../dist/infrastructure/postgres-order-drafts.js";
import { createJsonOrderDrafts } from "../dist/infrastructure/json/order-drafts.js";
import { checkedAudit } from "../dist/services/audit.js";
async function events(f) {
  if (f.provider === "json")
    return JSON.parse(
      await readFile(join(f.directory, "audit_logs.json"), "utf8"),
    ).map(checkedAudit);
  return (
    await f.pool.query(
      'SELECT id,company_id AS "companyId",actor_user_id AS "actorUserId",actor_role AS "actorRole",action,target_type AS "targetType",target_id AS "targetId",metadata,created_at AS "createdAt" FROM audit_logs',
    )
  ).rows.map((r) =>
    checkedAudit({ ...r, createdAt: r.createdAt.toISOString() }),
  );
}
for (const provider of ["json", "postgresql"])
  test(
    provider +
      ": composed security, account, assignment, staff and order producers append safe scoped audit records",
    {
      skip:
        provider === "postgresql" &&
        !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
        "PostgreSQL required",
    },
    async (t) => {
      const f = await adminFixture(t, provider),
        cid = f.data.companies[0].id;
      const adminSession = await f.login(0),
        customerSession = await f.login(2);
      const auth = createAuthorization(f.auth.authenticateAccess);
      const admin = await auth.admit(adminSession.accessToken, "profile.read"),
        customer = await auth.admit(
          customerSession.accessToken,
          "profile.read",
        );
      await assert.rejects(f.login(2, "IncorrectSyntheticPassword"), {
        code: "invalid_credentials",
      });
      const refreshed = await f.auth.refresh(
        { refreshToken: customerSession.refreshToken },
        randomUUID(),
      );
      await f.auth.revoke(refreshed.accessToken, randomUUID());
      const staff = (
        await f.staffService.create(
          admin,
          {
            displayName: "Synthetic audit staff",
            email: "audit-staff@example.test",
            temporaryPassword: " TemporarySynthetic123! ",
          },
          randomUUID(),
        )
      ).user;
      await f.staffService.change(
        admin,
        staff.id,
        { expectedStatus: "ACTIVE" },
        "DEACTIVATED",
        randomUUID(),
      );
      await f.staffService.change(
        admin,
        staff.id,
        { expectedStatus: "DEACTIVATED" },
        "ACTIVE",
        randomUUID(),
      );
      const first = (
        await f.options.adminSalesAssignments.assign(
          admin,
          cid,
          { salesStaffUserId: f.data.users[1].id, expectedAssignmentId: null },
          randomUUID(),
        )
      ).assignment;
      await f.options.adminSalesAssignments.assign(
        admin,
        cid,
        { salesStaffUserId: staff.id, expectedAssignmentId: first.id },
        randomUUID(),
      );
      for (const kind of ["company", "user"]) {
        const target =
          kind === "company" ? f.data.companies[1].id : f.data.users[5].id;
        await f.options.accountStatus.change(
          admin,
          kind,
          target,
          { expectedStatus: "ACTIVE", status: "SUSPENDED" },
          randomUUID(),
        );
        await f.options.accountStatus.change(
          admin,
          kind,
          target,
          { expectedStatus: "SUSPENDED", status: "ACTIVE" },
          randomUUID(),
        );
      }
      const buyer = await auth.admit(
        (await f.login(2)).accessToken,
        "profile.read",
      );
      const drafts = createOrderDrafts(
        provider === "json"
          ? createJsonOrderDrafts(f.security, f.now)
          : createPostgresOrderDrafts(f.pool, f.now),
        f.record,
      );
      const draft = (await drafts.create(buyer, {}, randomUUID())).draft;
      const rows = await events(f);
      const required = [
        "login.failed",
        "login.succeeded",
        "session.issued",
        "session.refreshed",
        "session.revoked",
        "sales_staff.created",
        "sales_staff.deactivated",
        "sales_staff.activated",
        "sales_assignment.assigned",
        "sales_assignment.reassigned",
        "company.suspended",
        "company.reactivated",
        "user.suspended",
        "user.reactivated",
        "order.created",
      ];
      for (const action of required)
        assert.ok(
          rows.some((r) => r.action === action),
          action,
        );
      const created = rows.filter(
        (r) => r.action === "order.created" && r.targetId === draft.id,
      );
      assert.equal(created.length, 1);
      assert.equal(created[0].actorUserId, buyer.userId);
      assert.equal(created[0].actorRole, "CUSTOMER_ADMIN");
      assert.equal(created[0].companyId, cid);
      for (const action of required.filter(
        (a) => !["login.succeeded", "session.issued"].includes(a),
      ))
        assert.equal(
          rows.filter((r) => r.action === action).length,
          1,
          action + " duplicated",
        );
      for (const r of rows) {
        assert.ok(r.createdAt);
        assert.ok(r.targetType);
        if (
          r.action.startsWith("sales_") ||
          /^(?:company|user)\.(?:suspended|reactivated)$/.test(r.action)
        )
          assert.equal(r.actorUserId, admin.userId);
        assert.ok(
          Object.keys(r.metadata).every((k) =>
            [
              "requestId",
              "transactionId",
              "orderId",
              "reasonCode",
              "outcome",
              "changedFields",
            ].includes(k),
          ),
        );
      }
      const failed = rows.find((r) => r.action === "login.failed");
      assert.equal(failed.actorUserId, null);
      assert.equal(failed.targetId, null);
      assert.doesNotMatch(
        JSON.stringify(rows),
        /TemporarySynthetic|IncorrectSynthetic|passwordHash|refreshToken|accessToken|audit-staff@example|PRIVATE_REQUEST|PRIVATE_RESPONSE|PRIVATE_ERROR/,
      );
      const before = rows.length;
      await assert.rejects(
        f.options.accountStatus.change(
          customer,
          "company",
          cid,
          { expectedStatus: "ACTIVE", status: "SUSPENDED" },
          randomUUID(),
        ),
        { name: "AuthorizationError" },
      );
      await assert.rejects(
        f.options.adminSalesAssignments.assign(
          admin,
          cid,
          { salesStaffUserId: staff.id, expectedAssignmentId: first.id },
          randomUUID(),
        ),
      );
      assert.equal(
        (await events(f)).length,
        before,
        "denied and stale commands must not emit success",
      );
    },
  );
