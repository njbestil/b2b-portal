import type { Pool, PoolClient } from "pg";
import type {
  AssignmentAdminActor,
  AdminSalesAssignmentRepository,
} from "../repositories/admin-sales-assignments.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SalesAssignment } from "../repositories/sales-assignments.js";
import {
  AssignmentManagementError,
  checkedAssignmentChange,
  managementId,
} from "../services/admin-sales-assignments.js";
import { checkedAssignments } from "../services/sales-assignments.js";
import { assignmentAdminActor } from "./assignment-admin-state.js";
import { lockedSession } from "./postgres-sessions.js";
import { SessionError } from "../services/session-state.js";
type UserRow = Omit<LoginCredential, "companyStatus">;
type AssignmentRow = Omit<SalesAssignment, "createdAt" | "endedAt"> & {
  createdAt: Date;
  endedAt: Date | null;
};
const projection =
  'id,company_id AS "companyId",sales_staff_user_id AS "salesStaffUserId",assigned_by_user_id AS "assignedByUserId",is_primary AS "isPrimary",active,created_at AS "createdAt",ended_at AS "endedAt"';
const canonical = (row: AssignmentRow): SalesAssignment => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  endedAt: row.endedAt?.toISOString() ?? null,
});
export function createPostgresAdminSalesAssignments(
  pool: Pool,
  now = Date.now,
): AdminSalesAssignmentRepository {
  async function run<T>(
    actor: AssignmentAdminActor,
    companyId: string,
    staffId: string | undefined,
    work: (
      client: PoolClient,
      company: { status: string },
      users: UserRow[],
      rows: SalesAssignment[],
    ) => Promise<T>,
  ): Promise<T> {
    managementId(actor.userId);
    managementId(actor.sessionId);
    managementId(companyId);
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw new AssignmentManagementError("unavailable");
    }
    let broken = false;
    const onError = () => {
      broken = true;
    };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      const company = (
        await client.query<{ status: string }>(
          "SELECT status FROM companies WHERE id=$1 FOR UPDATE",
          [companyId],
        )
      ).rows[0];
      const users = (
        await client.query<UserRow>(
          'SELECT id,company_id AS "companyId",display_name AS "displayName",role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword" FROM users WHERE id=$1 OR (id=$2 AND role=\'SALES_STAFF\' AND company_id IS NULL) ORDER BY id FOR UPDATE',
          [actor.userId, staffId ?? null],
        )
      ).rows;
      const admin = users.find((u) => u.id === actor.userId),
        account = admin ? { ...admin, companyStatus: null } : null,
        session = await lockedSession(client, actor.sessionId);
      assignmentAdminActor(actor, account, session, now());
      if (!company) throw new AssignmentManagementError("not_found");
      const rows = checkedAssignments(
        (
          await client.query<AssignmentRow>(
            `SELECT ${projection} FROM customer_sales_assignments WHERE company_id=$1 ORDER BY id LIMIT 10001 FOR UPDATE`,
            [companyId],
          )
        ).rows.map(canonical),
      );
      if (rows.some((r) => r.active && Date.parse(r.createdAt) > now()))
        throw new AssignmentManagementError("unavailable");
      const result = await work(client, company, users, rows);
      assignmentAdminActor(actor, account, session, now());
      if (broken) throw new AssignmentManagementError("unavailable");
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      if (e instanceof AssignmentManagementError || e instanceof SessionError)
        throw e;
      if (e && typeof e === "object" && "code" in e && e.code === "23505")
        throw new AssignmentManagementError("conflict");
      throw new AssignmentManagementError("unavailable");
    } finally {
      client.off("error", onError);
      client.release(broken);
    }
  }
  return {
    current: (actor, id) =>
      run(
        actor,
        id,
        undefined,
        async (_client, _company, _users, rows) =>
          rows.find((r) => r.active && r.isPrimary) ?? null,
      ),
    assign: (actor, value) => {
      const input = checkedAssignmentChange(value);
      return run(
        actor,
        input.companyId,
        input.salesStaffUserId,
        async (client, company, users, rows) => {
          const staff = users.find(
            (u) =>
              u.id === input.salesStaffUserId &&
              u.role === "SALES_STAFF" &&
              u.companyId === null,
          );
          if (!staff) throw new AssignmentManagementError("not_found");
          if (
            !["ACTIVE", "SUSPENDED"].includes(company.status) ||
            staff.status !== "ACTIVE"
          )
            throw new AssignmentManagementError("conflict");
          const current = rows.find((r) => r.active && r.isPrimary);
          if (
            (current?.id ?? null) !== input.expectedAssignmentId ||
            current?.salesStaffUserId === staff.id
          )
            throw new AssignmentManagementError("conflict");
          // Retain readable history: the next row must fit the same read bound.
          if (rows.length >= 10000)
            throw new AssignmentManagementError("unavailable");
          const time = new Date(now()).toISOString();
          await client.query(
            "UPDATE customer_sales_assignments SET active=false,ended_at=$2 WHERE company_id=$1 AND active",
            [input.companyId, time],
          );
          const row = (
            await client.query<AssignmentRow>(
              `INSERT INTO customer_sales_assignments(id,company_id,sales_staff_user_id,assigned_by_user_id,is_primary,active,created_at) VALUES($1,$2,$3,$4,true,true,$5) RETURNING ${projection}`,
              [input.id, input.companyId, staff.id, actor.userId, time],
            )
          ).rows[0]!;
          return canonical(row);
        },
      );
    },
  };
}
