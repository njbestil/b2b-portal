import type { Pool } from "pg";
import type { SalesAssignmentRepository } from "../repositories/sales-assignments.js";
import {
  assignmentId,
  SalesAssignmentError,
} from "../services/sales-assignments.js";
export function createPostgresSalesAssignments(
  pool: Pick<Pool, "query">,
  now = Date.now,
): SalesAssignmentRepository {
  return {
    async allows(staffId, companyId) {
      const staff = assignmentId(staffId),
        company = assignmentId(companyId);
      try {
        // One statement/snapshot after pool wait; no session-lifetime authority cache.
        const row = (
          await pool.query(
            `SELECT u.role,u.status,u.company_id AS "companyId",u.must_change_password AS "mustChangePassword",c.status AS "companyStatus",
          (SELECT count(*)::int FROM customer_sales_assignments a WHERE a.company_id=c.id AND a.active AND a.is_primary) AS "primaryCount",
          EXISTS(SELECT 1 FROM customer_sales_assignments a WHERE a.company_id=c.id AND a.active GROUP BY a.sales_staff_user_id HAVING count(*)>1) AS "duplicatePair",
          (SELECT count(*)::int FROM customer_sales_assignments a WHERE a.company_id=c.id AND a.active AND a.is_primary AND a.ended_at IS NULL AND a.sales_staff_user_id=u.id AND a.created_at <= $3::timestamptz) AS "matchingCount"
          FROM users u CROSS JOIN companies c WHERE u.id=$1 AND c.id=$2`,
            [staff, company, new Date(now()).toISOString()],
          )
        ).rows[0];
        if (!row) return false;
        if (row.primaryCount > 1 || row.matchingCount > 1 || row.duplicatePair)
          throw new Error();
        return (
          row.role === "SALES_STAFF" &&
          row.status === "ACTIVE" &&
          row.companyId === null &&
          row.mustChangePassword === false &&
          row.companyStatus === "ACTIVE" &&
          row.primaryCount === 1 &&
          row.matchingCount === 1
        );
      } catch {
        throw new SalesAssignmentError("unavailable");
      }
    },
    async ready() {
      try {
        await pool.query(
          "SELECT id,company_id,sales_staff_user_id,is_primary,active,assigned_by_user_id,created_at,ended_at FROM customer_sales_assignments LIMIT 0",
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
