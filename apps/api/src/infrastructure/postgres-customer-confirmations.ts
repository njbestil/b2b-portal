import type { Pool } from "pg";
import type {
  CustomerConfirmations,
  CustomerConfirmationActor,
  ConfirmationReview,
  ConfirmationDecision,
} from "../repositories/customer-confirmations.js";
import type { StoredConfirmation } from "../repositories/confirmation-requests.js";
import type { LoginCredential } from "../repositories/authentication.js";
import { DraftError } from "../services/order-drafts.js";
import { SessionError } from "../services/session-state.js";
import {
  checkedConfirmation,
  customerDecisionAllowed,
  decisionReplay,
} from "../services/customer-confirmations.js";
import { draftActor, nextDraftTime } from "./order-draft-state.js";
import { lockedSession } from "./postgres-sessions.js";
export function createPostgresCustomerConfirmations(
  pool: Pool,
  now = Date.now,
): CustomerConfirmations {
  async function run(
    a: CustomerConfirmationActor,
    id: string,
    decision?: { id: string; value: ConfirmationDecision },
  ): Promise<ConfirmationReview> {
    const c = await pool.connect().catch(() => {
      throw new DraftError("unavailable");
    });
    let broken = false;
    const fail = () => {
      broken = true;
    };
    c.on("error", fail);
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='5s'");
      const company = (
        await c.query("SELECT status FROM companies WHERE id=$1 FOR UPDATE", [
          a.companyId,
        ])
      ).rows[0];
      const user = (
        await c.query<LoginCredential>(
          'SELECT id,company_id AS "companyId",display_name AS "displayName",role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword" FROM users WHERE id=$1 FOR UPDATE',
          [a.userId],
        )
      ).rows[0];
      const session = await lockedSession(c, a.sessionId);
      const check = () => {
        draftActor(
          a,
          user ? { ...user, companyStatus: company?.status } : null,
          session,
          now(),
        );
        if (company?.status !== "ACTIVE") throw new DraftError("forbidden");
      };
      check();
      const order = (
        await c.query(
          "SELECT id,order_status AS status,integration_status AS integration,created_by_user_id AS creator,delivery_address_id AS address,updated_at AS updated,(submitted_at IS NOT NULL OR order_snapshot IS NOT NULL OR erp_order_reference IS NOT NULL OR idempotency_key IS NOT NULL) AS protected FROM orders WHERE id=$1 AND company_id=$2 FOR UPDATE",
          [id, a.companyId],
        )
      ).rows[0];
      if (!order) throw new DraftError("not_found");
      const raw = (
        await c.query(
          'SELECT id,company_id AS "companyId",order_id AS "orderId",customer_user_id AS "customerUserId",status,created_at AS "createdAt",request_fingerprint AS fingerprint,decided_by_user_id AS "decidedByUserId",decided_at AS "decidedAt",reason FROM order_confirmations WHERE order_id=$1 AND company_id=$2 FOR UPDATE',
          [id, a.companyId],
        )
      ).rows[0];
      if (!raw) throw new DraftError("not_found");
      let record = checkedConfirmation(sqlConfirmation(raw));
      customerDecisionAllowed(a, record);
      const creator = (
        await c.query(
          'SELECT role,company_id AS company,"display_name" AS name FROM users WHERE id=$1 FOR SHARE',
          [order.creator],
        )
      ).rows[0];
      if (
        !creator ||
        creator.role !== "SALES_STAFF" ||
        creator.company !== null ||
        order.creator === a.userId
      )
        throw new DraftError("forbidden");
      if (
        order.integration !== "NOT_SENT" ||
        order.protected ||
        order.status !==
          (record.status === "REJECTED"
            ? "REJECTED"
            : "PENDING_CUSTOMER_CONFIRMATION")
      )
        throw new DraftError("conflict");
      const items = (
        await c.query(
          'SELECT i.id,i.product_id AS "productId",i.quantity,p.name,p.sku,p.selling_uom AS "sellingUom" FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.company_id=$1 AND i.order_id=$2 ORDER BY i.id',
          [a.companyId, id],
        )
      ).rows;
      if (!items.length || items.length > 100) throw new DraftError("conflict");
      const address = order.address
        ? (
            await c.query(
              "SELECT label,address FROM delivery_addresses WHERE id=$1 AND company_id=$2",
              [order.address, a.companyId],
            )
          ).rows[0]
        : null;
      if (decision) {
        if (record.id !== decision.id) throw new DraftError("conflict");
        if (!decisionReplay(record, a, decision.value)) {
          const at = nextDraftTime(
            new Date(
              Math.max(Date.parse(record.createdAt), order.updated.getTime()),
            ).toISOString(),
            now(),
          );
          record = checkedConfirmation({
            ...record,
            status: decision.value.status,
            decidedAt: at,
            decidedByUserId: a.userId,
            reason: decision.value.reason,
          });
          await c.query(
            "UPDATE order_confirmations SET status=$1,decided_by_user_id=$2,decided_at=$3,reason=$4 WHERE id=$5 AND company_id=$6",
            [
              record.status,
              a.userId,
              at,
              decision.value.reason,
              record.id,
              a.companyId,
            ],
          );
          order.status =
            record.status === "REJECTED"
              ? "REJECTED"
              : "PENDING_CUSTOMER_CONFIRMATION";
          await c.query(
            "UPDATE orders SET order_status=$1,updated_at=$2 WHERE id=$3 AND company_id=$4",
            [order.status, at, id, a.companyId],
          );
        }
      }
      check();
      if (broken) throw new DraftError("unavailable");
      await c.query("COMMIT");
      return {
        confirmation: record,
        order: {
          id,
          status: order.status,
          createdBy: creator.name,
          items,
          delivery: address
            ? { label: address.label, line1: address.address.line1 }
            : null,
        },
      };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {
        broken = true;
      });
      if (e instanceof DraftError || e instanceof SessionError) throw e;
      throw new DraftError("unavailable");
    } finally {
      c.off("error", fail);
      c.release(broken);
    }
  }
  return {
    find: (a, id) => run(a, id),
    decide: (a, id, key, value) => run(a, id, { id: key, value }),
  };
}
export function sqlConfirmation(row: {
  id: string;
  companyId: string;
  orderId: string;
  customerUserId: string;
  status: StoredConfirmation["status"];
  createdAt: Date;
  fingerprint: string;
  decidedAt: Date | null;
  decidedByUserId: string | null;
  reason: string | null;
}): StoredConfirmation {
  const base = {
    id: row.id,
    companyId: row.companyId,
    orderId: row.orderId,
    customerUserId: row.customerUserId,
    createdAt: row.createdAt.toISOString(),
    fingerprint: row.fingerprint,
  };
  if (row.status === "PENDING") {
    if (
      row.decidedAt !== null ||
      row.decidedByUserId !== null ||
      row.reason !== null
    )
      throw new DraftError("unavailable");
    return { ...base, status: "PENDING" };
  }
  if (!row.decidedAt || !row.decidedByUserId)
    throw new DraftError("unavailable");
  return {
    ...base,
    status: row.status,
    decidedAt: row.decidedAt.toISOString(),
    decidedByUserId: row.decidedByUserId,
    reason: row.reason,
  };
}
