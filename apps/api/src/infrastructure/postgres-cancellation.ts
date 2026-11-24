import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { LoginCredential } from "../repositories/authentication.js";
import { eligible, SessionError } from "../services/session-state.js";
import { checkedAudit } from "../services/audit.js";
import {
  cancellationActor,
  cancellationId,
  cancellationReason,
  CancellationError,
} from "../services/cancellation.js";
import type { AuthorizedActor } from "../services/authorization.js";
import { bound } from "./session-crypto.js";
import { lockedSession } from "./postgres-sessions.js";
import type {
  CancellationRequest,
  CancellationDecision,
} from "./mock-cancellation-adapter.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type View = {
  requestId: string;
  orderId: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
};
export function createPostgresCancellation(
  pool: Pool,
  gateway?: {
    cancel(input: CancellationRequest): Promise<CancellationDecision>;
  },
) {
  return async function cancel(
    actor: AuthorizedActor,
    companyInput: unknown,
    orderInput: unknown,
    keyInput: unknown,
    input: unknown,
  ): Promise<View> {
    const who = cancellationActor(actor, companyInput),
      orderId = cancellationId(orderInput);
    if (
      typeof keyInput !== "string" ||
      !/^[\x21-\x7e]{1,128}$/.test(keyInput) ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).join(",") !== "reason"
    )
      throw new CancellationError("invalid_input");
    const reason = cancellationReason((input as { reason: unknown }).reason),
      keyHash = hash(keyInput),
      reasonHash = hash(reason);
    async function run<T>(
      work: (
        client: PoolClient,
        company: { status: string; reference: string | null },
        submissions: readonly { status: string }[],
      ) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      let broken = false;
      const onError = () => {
        broken = true;
      };
      client.on("error", onError);
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='5s'");
        const company = (
          await client.query(
            "SELECT status,erp_customer_reference AS reference FROM companies WHERE id=$1 FOR UPDATE",
            [who.companyId],
          )
        ).rows[0];
        const user = (
          await client.query<LoginCredential>(
            'SELECT id,company_id AS "companyId",display_name AS "displayName",role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword" FROM users WHERE id=$1 FOR UPDATE',
            [who.userId],
          )
        ).rows[0];
        const session = await lockedSession(client, who.sessionId);
        const check = () => {
          const time = Date.now(),
            account = user
              ? {
                  ...user,
                  companyStatus:
                    user.companyId === who.companyId
                      ? (company?.status ?? null)
                      : null,
                }
              : null;
          const current = eligible(account);
          if (
            current.id !== who.userId ||
            current.role !== who.role ||
            current.mustChangePassword ||
            !Number.isFinite(Date.parse(who.accessExpiresAt)) ||
            time >= Date.parse(who.accessExpiresAt) ||
            company?.status !== "ACTIVE"
          )
            throw new CancellationError("forbidden");
          bound(session, current, time);
        };
        check();
        if (who.role === "SALES_STAFF") {
          const assignments = (
            await client.query(
              'SELECT sales_staff_user_id AS "userId",is_primary AS "isPrimary",active,created_at AS "createdAt",ended_at AS "endedAt" FROM customer_sales_assignments WHERE company_id=$1 ORDER BY id LIMIT 10001 FOR UPDATE',
              [who.companyId],
            )
          ).rows;
          const active = assignments.filter((r) => r.active && r.isPrimary);
          if (
            assignments.length > 10000 ||
            active.length !== 1 ||
            active[0].userId !== who.userId ||
            active[0].endedAt !== null ||
            active[0].createdAt.getTime() > Date.now()
          )
            throw new CancellationError("not_found");
        }
        // Submission dispatch locks transaction before order; use the same order here.
        const submissions = (
          await client.query<{ status: string }>(
            "SELECT status FROM integration_transactions WHERE company_id=$1 AND order_id=$2 AND operation='ORDER_SUBMISSION' FOR UPDATE",
            [who.companyId, orderId],
          )
        ).rows;
        const value = await work(client, company, submissions);
        check();
        if (broken) throw new CancellationError("unavailable");
        await client.query("COMMIT");
        return value;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {
          broken = true;
        });
        if (e instanceof CancellationError || e instanceof SessionError)
          throw e;
        if (e && typeof e === "object" && "code" in e && e.code === "23505")
          throw new CancellationError("conflict");
        throw new CancellationError("unavailable");
      } finally {
        client.off("error", onError);
        client.release(broken);
      }
    }
    async function audit(
      client: PoolClient,
      action: string,
      requestId: string,
    ) {
      const row = checkedAudit({
        id: randomUUID(),
        companyId: who.companyId,
        actorUserId: who.userId,
        actorRole: who.role,
        action,
        targetType: "cancellation_request",
        targetId: requestId,
        metadata: { orderId, outcome: "success" },
        createdAt: new Date().toISOString(),
      });
      await client.query(
        "INSERT INTO audit_logs(id,company_id,actor_user_id,actor_role,action,target_type,target_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
        [
          row.id,
          row.companyId,
          row.actorUserId,
          row.actorRole,
          row.action,
          row.targetType,
          row.targetId,
          JSON.stringify(row.metadata),
          row.createdAt,
        ],
      );
    }
    const initial = await run(async (client, company, submissions) => {
      const previous = (
        await client.query(
          `SELECT k.company_id AS "companyId",k.order_id AS "orderId",k.user_id AS "userId",k.reason_hash AS "reasonHash",r.id AS "requestId",r.status FROM cancellation_idempotency k JOIN order_cancellation_requests r ON r.id=k.request_id AND r.company_id=k.company_id AND r.order_id=k.order_id AND r.requested_by_user_id=k.user_id WHERE k.key_hash=$1`,
          [keyHash],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.companyId !== who.companyId ||
          previous.orderId !== orderId ||
          previous.userId !== who.userId ||
          previous.reasonHash !== reasonHash
        )
          throw new CancellationError("conflict");
        return {
          requestId: previous.requestId,
          orderId,
          status: previous.status,
        } as View;
      }
      const order = (
        await client.query(
          'SELECT order_status AS status,integration_status AS integration,erp_order_reference AS "erpOrderId",created_by_user_id AS "createdByUserId",submitted_at AS "submittedAt",order_snapshot AS snapshot,idempotency_key AS "submissionKey" FROM orders WHERE id=$1 AND company_id=$2 FOR UPDATE',
          [orderId, who.companyId],
        )
      ).rows[0];
      if (!order) throw new CancellationError("not_found");
      if (order.status === "DRAFT" && order.createdByUserId !== who.userId)
        throw new CancellationError("not_found");
      if (["DELIVERED", "CANCELLED", "REJECTED"].includes(order.status))
        throw new CancellationError("conflict");
      const pending = (
        await client.query(
          "SELECT id FROM order_cancellation_requests WHERE order_id=$1 AND status='PENDING'",
          [orderId],
        )
      ).rows;
      if (pending.length) throw new CancellationError("conflict");
      const requestId = randomUUID(),
        timestamp = new Date().toISOString();
      let direct = false;
      if (
        !order.erpOrderId &&
        ["DRAFT", "PENDING_CUSTOMER_CONFIRMATION"].includes(order.status) &&
        order.integration === "NOT_SENT" &&
        order.submittedAt === null &&
        order.snapshot === null &&
        order.submissionKey === null &&
        submissions.length === 0
      )
        direct = true;
      else if (
        !order.erpOrderId &&
        order.status === "SUBMITTED" &&
        order.integration === "PENDING"
      ) {
        const stopped = await client.query(
          "UPDATE integration_transactions SET status='FAILED',retryable=false,next_retry_at=NULL,error_code='CANCELLED_BEFORE_SEND',updated_at=clock_timestamp() WHERE company_id=$1 AND order_id=$2 AND operation='ORDER_SUBMISSION' AND status='PENDING' RETURNING id",
          [who.companyId, orderId],
        );
        if (stopped.rowCount !== 1) throw new CancellationError("conflict");
        await client.query(
          "UPDATE orders SET integration_status='FAILED' WHERE id=$1 AND company_id=$2",
          [orderId, who.companyId],
        );
        direct = true;
      } else if (
        !order.erpOrderId ||
        !company.reference ||
        submissions.some((tx) =>
          ["PENDING", "PROCESSING", "RETRYING"].includes(tx.status),
        ) ||
        !["SUBMITTED", "CONFIRMED", "FULFILLING"].includes(order.status)
      )
        throw new CancellationError("conflict");
      if (!direct && !gateway) throw new CancellationError("unavailable");
      await client.query(
        "INSERT INTO order_cancellation_requests(id,company_id,order_id,requested_by_user_id,reason,status,created_at,decided_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          requestId,
          who.companyId,
          orderId,
          who.userId,
          reason,
          direct ? "APPROVED" : "PENDING",
          timestamp,
          direct ? timestamp : null,
        ],
      );
      await client.query(
        "INSERT INTO cancellation_idempotency(key_hash,company_id,order_id,user_id,request_id,reason_hash) VALUES($1,$2,$3,$4,$5,$6)",
        [keyHash, who.companyId, orderId, who.userId, requestId, reasonHash],
      );
      await audit(client, "order.cancellation_requested", requestId);
      if (direct) {
        await client.query(
          "UPDATE orders SET order_status='CANCELLED',updated_at=$1 WHERE id=$2 AND company_id=$3",
          [timestamp, orderId, who.companyId],
        );
        await audit(client, "order.cancellation_completed", requestId);
      } else {
        const payload = {
          requestId,
          orderId,
          erpOrderId: order.erpOrderId,
          customerReference: company.reference,
          reason,
          expectedStatus: order.status,
        };
        await client.query(
          "INSERT INTO integration_transactions(id,company_id,order_id,operation,idempotency_key,status,request_payload) VALUES($1,$2,$3,'ORDER_CANCELLATION',$4,'PENDING',$5::jsonb)",
          [
            randomUUID(),
            who.companyId,
            orderId,
            requestId,
            JSON.stringify(payload),
          ],
        );
      }
      return {
        requestId,
        orderId,
        status: direct ? "APPROVED" : "PENDING",
      } as View;
    });
    if (initial.status !== "PENDING") return initial;
    if (!gateway) throw new CancellationError("unavailable");
    const claimed = await run(async (client, company, submissions) => {
      const tx = (
        await client.query(
          "SELECT id,request_payload AS payload FROM integration_transactions WHERE company_id=$1 AND order_id=$2 AND operation='ORDER_CANCELLATION' AND idempotency_key=$3 AND status='PENDING' FOR UPDATE",
          [who.companyId, orderId, initial.requestId],
        )
      ).rows[0];
      if (!tx) return null;
      const order = (
          await client.query(
            'SELECT order_status AS status,erp_order_reference AS "erpOrderId" FROM orders WHERE company_id=$1 AND id=$2 FOR UPDATE',
            [who.companyId, orderId],
          )
        ).rows[0],
        p = tx.payload;
      if (
        !order ||
        submissions.some((tx) =>
          ["PENDING", "PROCESSING", "RETRYING"].includes(tx.status),
        ) ||
        order.status !== p.expectedStatus ||
        order.erpOrderId !== p.erpOrderId ||
        company.reference !== p.customerReference ||
        p.requestId !== initial.requestId ||
        p.orderId !== orderId ||
        p.reason !== reason
      )
        throw new CancellationError("conflict");
      await client.query(
        "UPDATE integration_transactions SET status='PROCESSING',updated_at=clock_timestamp() WHERE id=$1",
        [tx.id],
      );
      return { id: tx.id, payload: p };
    });
    if (!claimed) return initial;
    let decision: CancellationDecision;
    try {
      decision = await gateway!.cancel(claimed.payload);
    } catch {
      decision = { outcome: "unknown" };
    }
    if (decision.outcome === "unknown") {
      await run(async (client) => {
        await client.query(
          "UPDATE integration_transactions SET status='FAILED',retryable=false,error_code='OUTCOME_UNKNOWN',updated_at=clock_timestamp() WHERE id=$1 AND status='PROCESSING'",
          [claimed.id],
        );
      });
      return initial;
    }
    return run(async (client, company, submissions) => {
      const tx = (
        await client.query(
          "SELECT id FROM integration_transactions WHERE id=$1 AND status='PROCESSING' FOR UPDATE",
          [claimed.id],
        )
      ).rows[0];
      const order = (
          await client.query(
            'SELECT order_status AS status,erp_order_reference AS "erpOrderId" FROM orders WHERE company_id=$1 AND id=$2 FOR UPDATE',
            [who.companyId, orderId],
          )
        ).rows[0],
        p = claimed.payload;
      if (
        !tx ||
        submissions.some((row) =>
          ["PENDING", "PROCESSING", "RETRYING"].includes(row.status),
        ) ||
        !order ||
        order.status !== p.expectedStatus ||
        order.erpOrderId !== p.erpOrderId ||
        company.reference !== p.customerReference
      )
        throw new CancellationError("conflict");
      const status = decision.outcome === "approved" ? "APPROVED" : "REJECTED";
      const updated = await client.query(
        "UPDATE order_cancellation_requests SET status=$1,decided_at=$2 WHERE id=$3 AND company_id=$4 AND order_id=$5 AND status='PENDING' RETURNING id",
        [status, decision.decidedAt, initial.requestId, who.companyId, orderId],
      );
      if (updated.rowCount !== 1) throw new CancellationError("conflict");
      if (status === "APPROVED")
        await client.query(
          "UPDATE orders SET order_status='CANCELLED',updated_at=clock_timestamp() WHERE id=$1 AND company_id=$2",
          [orderId, who.companyId],
        );
      await client.query(
        "UPDATE integration_transactions SET status='SUCCESS',response_payload=$1::jsonb,updated_at=clock_timestamp() WHERE id=$2",
        [
          JSON.stringify({
            outcome: decision.outcome,
            decidedAt: decision.decidedAt,
          }),
          claimed.id,
        ],
      );
      await audit(client, "order.cancellation_decided", initial.requestId);
      return { requestId: initial.requestId, orderId, status } as View;
    });
  };
}
export type OrderCancellation = ReturnType<typeof createPostgresCancellation>;
