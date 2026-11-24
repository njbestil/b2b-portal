import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  MockSubmissionRequest,
  MockSubmissionResult,
} from "./mock-submission-adapter.js";
import { createPostgresSubmissionDispatch } from "./postgres-submission-dispatch.js";
import { integrationMonitorActor } from "./integration-monitor-state.js";
import {
  checkedRetryVersion,
  ManualRetryError,
} from "../services/manual-retry.js";
import { retryableSubmission } from "../services/retryable-submission.js";
import { monitorId } from "../services/integration-monitor.js";
import {
  requirePermission,
  type AuthorizedActor,
} from "../services/authorization.js";
import { checkedAudit } from "../services/audit.js";

function checkedPayload(
  value: unknown,
  orderId: string,
  reference: string,
  customer: string,
): MockSubmissionRequest {
  const p = value as MockSubmissionRequest | null;
  if (
    !p ||
    p.portalOrderId !== orderId ||
    p.externalRequestReference !== reference ||
    p.customerId !== customer ||
    typeof customer !== "string" ||
    !customer.trim() ||
    !Array.isArray(p.items) ||
    !p.items.length ||
    p.items.length > 100 ||
    Buffer.byteLength(JSON.stringify(p)) > 32768 ||
    p.items.some(
      (i) =>
        !i ||
        typeof i.quantity !== "string" ||
        typeof i.unitPrice !== "string" ||
        typeof i.currency !== "string" ||
        typeof i.productId !== "string" ||
        !i.productId.trim() ||
        !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(i.quantity) ||
        !/[1-9]/.test(i.quantity) ||
        !/^(?:0|[1-9]\d{0,23})(?:\.\d{1,18})?$/.test(i.unitPrice) ||
        !/^[A-Z]{3}$/.test(i.currency) ||
        !["Piece", "Pack", "Carton", "Case", "Bag", "KG"].includes(
          i.sellingUom,
        ) ||
        !i.snapshot ||
        typeof i.snapshot.sku !== "string" ||
        !i.snapshot.sku.trim() ||
        typeof i.snapshot.name !== "string" ||
        !i.snapshot.name.trim(),
    )
  )
    throw new ManualRetryError("unavailable");
  return structuredClone(p);
}
export function createPostgresManualRetry(
  pool: Pool,
  gateway: {
    send(request: MockSubmissionRequest): Promise<MockSubmissionResult>;
  },
  now = Date.now,
) {
  const dispatch = createPostgresSubmissionDispatch(pool, gateway);
  return async (
    actor: AuthorizedActor,
    id: unknown,
    input: unknown,
    signal: AbortSignal,
  ) => {
    requirePermission(actor, "integration-transactions.retry");
    const transactionId = monitorId(id),
      expected = checkedRetryVersion(input);
    const identity = {
      userId: actor.userId,
      sessionId: actor.sessionId,
      accessExpiresAt: actor.accessExpiresAt,
    };
    let companyId: string | undefined, orderId: string | undefined;
    try {
      const client = await pool.connect();
      let broken = false;
      const onError = () => {
        broken = true;
      };
      client.on("error", onError);
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='2s'");
        const target = (
          await client.query(
            "SELECT company_id,order_id FROM integration_transactions WHERE id=$1",
            [transactionId],
          )
        ).rows[0];
        if (!target) throw new ManualRetryError("not_found");
        // Match company -> actor -> session -> transaction -> order lock ordering.
        const company = (
          await client.query(
            "SELECT status,erp_customer_reference AS reference FROM companies WHERE id=$1 FOR SHARE",
            [target.company_id],
          )
        ).rows[0];
        const account = (
          await client.query(
            'SELECT id,company_id AS "companyId",display_name AS "displayName",role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword" FROM users WHERE id=$1 FOR UPDATE',
            [actor.userId],
          )
        ).rows[0];
        const session = (
          await client.query(
            'SELECT id,user_id AS "userId",refresh_token_hash AS "refreshTokenHash",credential_fingerprint AS "credentialFingerprint",created_at AS "createdAt",expires_at AS "expiresAt",revoked_at AS "revokedAt" FROM user_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
            [actor.sessionId, actor.userId],
          )
        ).rows[0];
        integrationMonitorActor(
          identity,
          account,
          session
            ? {
                ...session,
                createdAt: session.createdAt.toISOString(),
                expiresAt: session.expiresAt.toISOString(),
                revokedAt: session.revokedAt?.toISOString() ?? null,
              }
            : null,
          now(),
          signal,
        );
        const tx = (
          await client.query(
            "SELECT * FROM integration_transactions WHERE id=$1 FOR UPDATE",
            [transactionId],
          )
        ).rows[0];
        if (!tx) throw new ManualRetryError("not_found");
        if (
          tx.company_id !== target.company_id ||
          tx.order_id !== target.order_id ||
          tx.operation !== "ORDER_SUBMISSION" ||
          tx.status !== "FAILED" ||
          tx.retryable !== true ||
          tx.retry_count !== expected.retryCount ||
          tx.updated_at.toISOString() !== expected.updatedAt ||
          !retryableSubmission(tx.response_payload) ||
          tx.response_payload.code !== tx.error_code
        )
          throw new ManualRetryError("conflict");
        const order = (
          await client.query(
            "SELECT order_status AS status,integration_status AS integration,erp_order_reference AS reference FROM orders WHERE id=$1 AND company_id=$2 FOR UPDATE",
            [tx.order_id, tx.company_id],
          )
        ).rows[0];
        if (
          !company ||
          company.status !== "ACTIVE" ||
          !order ||
          order.status !== "SUBMITTED" ||
          order.integration !== "FAILED" ||
          order.reference !== null
        )
          throw new ManualRetryError("conflict");
        checkedPayload(
          tx.request_payload,
          tx.order_id,
          tx.idempotency_key,
          company.reference,
        );
        integrationMonitorActor(
          identity,
          account,
          session
            ? {
                ...session,
                createdAt: session.createdAt.toISOString(),
                expiresAt: session.expiresAt.toISOString(),
                revokedAt: session.revokedAt?.toISOString() ?? null,
              }
            : null,
          now(),
          signal,
        );
        await client.query(
          "UPDATE integration_transactions SET status='PENDING',retryable=false,retry_count=retry_count+1,next_retry_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
          [transactionId],
        );
        await client.query(
          "UPDATE orders SET integration_status='PENDING',updated_at=clock_timestamp() WHERE id=$1",
          [tx.order_id],
        );
        const audit = checkedAudit({
          id: randomUUID(),
          createdAt: new Date(now()).toISOString(),
          companyId: tx.company_id,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: "integration.retry_requested",
          targetType: "integration_transaction",
          targetId: transactionId,
          metadata: { transactionId, orderId: tx.order_id, outcome: "success" },
        });
        await client.query(
          "INSERT INTO audit_logs(id,company_id,actor_user_id,actor_role,action,target_type,target_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
          [
            audit.id,
            audit.companyId,
            audit.actorUserId,
            audit.actorRole,
            audit.action,
            audit.targetType,
            audit.targetId,
            JSON.stringify(audit.metadata),
            audit.createdAt,
          ],
        );
        if (broken) throw new ManualRetryError("unavailable");
        await client.query("COMMIT");
        companyId = tx.company_id;
        orderId = tx.order_id;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {
          broken = true;
        });
        throw e;
      } finally {
        client.off("error", onError);
        client.release(broken);
      }
      await dispatch(companyId!, orderId!);
      return { transactionId };
    } catch (e) {
      if (
        e instanceof ManualRetryError ||
        (e instanceof Error &&
          [
            "SessionError",
            "AuthorizationError",
            "IntegrationMonitorError",
          ].includes(e.name))
      )
        throw e;
      throw new ManualRetryError("unavailable");
    }
  };
}
export type ManualRetry = ReturnType<typeof createPostgresManualRetry>;
