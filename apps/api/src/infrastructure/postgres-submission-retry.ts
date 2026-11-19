import type { Pool } from "pg";
import type {
  MockSubmissionRequest,
  MockSubmissionResult,
} from "./mock-submission-adapter.js";
import type { SubmissionRetryPolicy } from "./submission-retry-config.js";

const retryable = new Set([
  "ERP_TIMEOUT",
  "ERP_UNAVAILABLE",
  "ERP_TEMPORARY_FAILURE",
]);

/** Called only after the durable initial claim. Interrupted PROCESSING stays
 * uncertain and is never reclaimed, even if a retry timer had been scheduled. */
export function createPostgresRetryingGateway(
  pool: Pick<Pool, "query">,
  gateway: {
    send(request: MockSubmissionRequest): Promise<MockSubmissionResult>;
  },
  policy: SubmissionRetryPolicy,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
) {
  return {
    async send(request: MockSubmissionRequest): Promise<MockSubmissionResult> {
      const retained = structuredClone(request);
      for (;;) {
        let result: MockSubmissionResult;
        try {
          result = await gateway.send(structuredClone(retained));
        } catch {
          return { outcome: "uncertain" };
        }
        if (result.outcome !== "rejected" || !retryable.has(result.code))
          return result;
        let allocation;
        try {
          allocation = await pool.query(
            `UPDATE integration_transactions SET retry_count=retry_count+1, next_retry_at=clock_timestamp()+(LEAST($3::integer * (1 << LEAST(retry_count,5)),30000) * interval '1 millisecond'), error_code=$4, updated_at=clock_timestamp()
            WHERE idempotency_key=$1 AND order_id=$2 AND operation='ORDER_SUBMISSION' AND status='PROCESSING' AND retry_count < $5 RETURNING id, LEAST($3::integer * (1 << LEAST(retry_count-1,5)),30000) AS delay_ms`,
            [
              retained.externalRequestReference,
              retained.portalOrderId,
              policy.delayMs,
              result.code,
              policy.maxRetries,
            ],
          );
        } catch {
          return { outcome: "uncertain" };
        }
        if (allocation.rowCount === 0) return result;
        if (allocation.rowCount !== 1) return { outcome: "uncertain" };
        try {
          await wait(allocation.rows[0].delay_ms);
          const clear = await pool.query(
            `UPDATE integration_transactions SET next_retry_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='PROCESSING' RETURNING id`,
            [allocation.rows[0].id],
          );
          if (clear.rowCount !== 1) return { outcome: "uncertain" };
        } catch {
          return { outcome: "uncertain" };
        }
      }
    },
  };
}
