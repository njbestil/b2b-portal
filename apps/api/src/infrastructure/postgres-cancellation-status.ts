import type { Pool } from "pg";
import type { CancellationStatusRepository } from "../repositories/cancellation-status.js";
import { CancellationError } from "../services/cancellation.js";
export function createPostgresCancellationStatus(
  pool: Pool,
): CancellationStatusRepository {
  return {
    async latest(companyId, orderId) {
      try {
        const row = (
          await pool.query(
            `SELECT o.created_by_user_id AS "createdByUserId",o.order_status AS "orderStatus",
        c.id AS "requestId",c.status FROM orders o LEFT JOIN LATERAL
        (SELECT id,status FROM order_cancellation_requests WHERE company_id=o.company_id AND order_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1) c ON true
        WHERE o.id=$1 AND o.company_id=$2`,
            [orderId, companyId],
          )
        ).rows[0];
        return row
          ? {
              createdByUserId: row.createdByUserId,
              orderStatus: row.orderStatus,
              cancellation: row.requestId
                ? { requestId: row.requestId, orderId, status: row.status }
                : null,
            }
          : null;
      } catch {
        throw new CancellationError("unavailable");
      }
    },
  };
}
