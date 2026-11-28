import type { Pool, PoolClient } from "pg";
import type { OrderSnapshot } from "../repositories/order-snapshots.js";
import { checkedOrderSnapshot } from "../services/order-snapshot.js";
import {
  compareDecimals,
  submissionDecimal,
} from "../services/submission-decimal.js";

/** Owns the transaction. The trusted callback must revalidate authority, live
 * commercial data, draft version and later idempotency, then transition exactly
 * one matching order to SUBMITTED using this client. No ERP call inside the
 * callback. An exception rolls back both transition and snapshot publication. */
export async function withPostgresOrderSnapshot(
  pool: Pool,
  transition: (client: PoolClient) => Promise<OrderSnapshot>,
  confirmationId?: string,
): Promise<OrderSnapshot> {
  const client = await pool.connect();
  let broken = false;
  const onError = () => {
    broken = true;
  };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    const snapshot = checkedOrderSnapshot(await transition(client));
    const order = (
      await client.query(
        `SELECT company_id AS "companyId",created_by_user_id AS "userId",delivery_address_id AS "addressId",order_status AS status,submitted_at AS "submittedAt",order_snapshot AS snapshot,currency,total_amount AS total FROM orders WHERE id=$1 FOR UPDATE`,
        [snapshot.orderId],
      )
    ).rows[0];
    let approved = false;
    if (confirmationId && order && order.userId !== snapshot.submittedBy.id) {
      approved =
        (
          await client.query(
            "SELECT c.id FROM order_confirmations c JOIN users u ON u.id=$4 WHERE c.id=$1 AND c.company_id=$2 AND c.order_id=$3 AND c.status='CONFIRMED' AND c.decided_by_user_id=$5 AND u.role='SALES_STAFF' AND u.company_id IS NULL FOR SHARE OF c,u",
            [
              confirmationId,
              snapshot.companyId,
              snapshot.orderId,
              order.userId,
              snapshot.submittedBy.id,
            ],
          )
        ).rowCount === 1;
    }
    if (
      !order ||
      order.companyId !== snapshot.companyId ||
      (order.userId !== snapshot.submittedBy.id && !approved) ||
      order.addressId !== snapshot.delivery.id ||
      order.status !== "SUBMITTED" ||
      !(order.submittedAt instanceof Date) ||
      order.submittedAt.toISOString() !== snapshot.submittedAt ||
      order.snapshot !== null ||
      order.currency !== null ||
      order.total !== null
    )
      throw new Error("Snapshot order state conflict.");
    const rows = (
      await client.query(
        `SELECT id,product_id AS "productId",quantity::text,unit_price AS "unitPrice",line_total AS "lineTotal",item_snapshot AS snapshot FROM order_items WHERE company_id=$1 AND order_id=$2 ORDER BY id FOR UPDATE`,
        [snapshot.companyId, snapshot.orderId],
      )
    ).rows;
    if (rows.length !== snapshot.items.length)
      throw new Error("Snapshot line conflict.");
    for (const item of snapshot.items) {
      const row = rows.find((r) => r.id === item.itemId);
      if (
        !row ||
        row.productId !== item.productId ||
        compareDecimals(
          submissionDecimal(row.quantity),
          submissionDecimal(item.quantity),
        ) !== 0 ||
        row.unitPrice !== null ||
        row.lineTotal !== null ||
        row.snapshot !== null
      )
        throw new Error("Snapshot line conflict.");
    }
    await client.query(
      "UPDATE orders SET order_snapshot=$1::jsonb,currency=$2,total_amount=$3 WHERE id=$4 AND company_id=$5",
      [
        JSON.stringify(snapshot),
        snapshot.currency,
        snapshot.total,
        snapshot.orderId,
        snapshot.companyId,
      ],
    );
    for (const item of snapshot.items)
      await client.query(
        "UPDATE order_items SET item_snapshot=$1::jsonb,unit_price=$2,line_total=$3 WHERE id=$4 AND order_id=$5 AND company_id=$6",
        [
          JSON.stringify(item),
          item.unitPrice,
          item.lineTotal,
          item.itemId,
          snapshot.orderId,
          snapshot.companyId,
        ],
      );
    if (broken) throw new Error("Snapshot transaction unavailable.");
    await client.query("COMMIT");
    return snapshot;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      broken = true;
    });
    throw error;
  } finally {
    client.off("error", onError);
    client.release(broken);
  }
}
