import type { Pool } from "pg";
import type {
  MockSubmissionRequest,
  MockSubmissionResult,
} from "./mock-submission-adapter.js";

/** PENDING may be claimed only once. PROCESSING is deliberately not reclaimed:
 * the provider may have accepted the request before a worker or connection died. */
export function createPostgresSubmissionDispatch(
  pool: Pool,
  gateway: {
    send(request: MockSubmissionRequest): Promise<MockSubmissionResult>;
  },
) {
  return async function dispatch(
    companyId: string,
    orderId: string,
  ): Promise<void> {
    const claimClient = await pool.connect();
    let claimBroken = false;
    const onClaimError = () => {
      claimBroken = true;
    };
    claimClient.on("error", onClaimError);
    let row;
    try {
      await claimClient.query("BEGIN");
      await claimClient.query("SET LOCAL lock_timeout='5s'");
      const claimed = await claimClient.query(
        `UPDATE integration_transactions SET status='PROCESSING', updated_at=clock_timestamp()
       WHERE company_id=$1 AND order_id=$2 AND operation='ORDER_SUBMISSION' AND status='PENDING'
       RETURNING id, idempotency_key, request_payload`,
        [companyId, orderId],
      );
      if (claimed.rowCount === 0) {
        await claimClient.query("COMMIT");
        return;
      }
      if (claimed.rowCount !== 1)
        throw new Error("Submission dispatch state unavailable.");
      const order = await claimClient.query(
        `UPDATE orders SET integration_status='PROCESSING', updated_at=clock_timestamp()
         WHERE id=$1 AND company_id=$2 AND integration_status='PENDING'`,
        [orderId, companyId],
      );
      if (order.rowCount !== 1 || claimBroken)
        throw new Error("Submission dispatch state unavailable.");
      row = claimed.rows[0];
      await claimClient.query("COMMIT");
    } catch (error) {
      await claimClient.query("ROLLBACK").catch(() => {
        claimBroken = true;
      });
      throw error;
    } finally {
      claimClient.off("error", onClaimError);
      claimClient.release(claimBroken);
    }
    const payload = row.request_payload as MockSubmissionRequest;
    if (
      !payload ||
      payload.portalOrderId !== orderId ||
      payload.externalRequestReference !== row.idempotency_key
    )
      throw new Error("Submission dispatch state unavailable.");
    let result: MockSubmissionResult;
    try {
      result = await gateway.send(payload);
    } catch {
      result = { outcome: "uncertain" };
    }
    const client = await pool.connect();
    let broken = false;
    const onError = () => {
      broken = true;
    };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE integration_transactions SET status=$1, retryable=false, error_code=$2, response_payload=$3::jsonb, updated_at=clock_timestamp()
         WHERE id=$4 AND company_id=$5 AND order_id=$6 AND status='PROCESSING' RETURNING id`,
        [
          result.outcome === "accepted" ? "SUCCESS" : "FAILED",
          result.outcome === "uncertain"
            ? "OUTCOME_UNKNOWN"
            : result.outcome === "rejected"
              ? result.code
              : null,
          JSON.stringify(result),
          row.id,
          companyId,
          orderId,
        ],
      );
      if (updated.rowCount !== 1)
        throw new Error("Submission dispatch state unavailable.");
      const order = await client.query(
        `UPDATE orders SET integration_status=$1, erp_order_reference=$2, updated_at=clock_timestamp()
         WHERE id=$3 AND company_id=$4 AND erp_order_reference IS NULL AND integration_status='PROCESSING'`,
        [
          result.outcome === "accepted" ? "SUCCESS" : "FAILED",
          result.outcome === "accepted" ? result.erpOrderReference : null,
          orderId,
          companyId,
        ],
      );
      if (order.rowCount !== 1)
        throw new Error("Submission dispatch state unavailable.");
      if (broken) throw new Error("Submission dispatch state unavailable.");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      throw error;
    } finally {
      client.off("error", onError);
      client.release(broken);
    }
  };
}
