import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ConfirmationRequests,
  ConfirmationActor,
  PendingConfirmation,
} from "../repositories/confirmation-requests.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { OrderSummary } from "../repositories/orders.js";
import { DraftError } from "../services/order-drafts.js";
import { SessionError } from "../services/session-state.js";
import {
  draftActor,
  canonicalDraft,
  nextDraftTime,
} from "./order-draft-state.js";
import { lockedSession } from "./postgres-sessions.js";
import {
  confirmationFingerprint,
  pendingReplay,
} from "./confirmation-request-state.js";
const projection =
  'id,company_id AS "companyId",created_by_user_id AS "createdByUserId",order_number AS "orderNumber",created_at AS "createdAt",updated_at AS "updatedAt",order_status AS status,integration_status AS "integrationStatus",delivery_address_id AS "deliveryAddressId",(submitted_at IS NOT NULL OR order_snapshot IS NOT NULL OR erp_order_reference IS NOT NULL OR idempotency_key IS NOT NULL) AS protected';
type Row = Omit<OrderSummary, "createdAt"> & {
  createdAt: Date;
  updatedAt: Date;
  deliveryAddressId: string | null;
  protected: boolean;
};
export function createPostgresConfirmationRequests(
  pool: Pool,
  now = Date.now,
  newId = randomUUID,
): ConfirmationRequests {
  async function run<T>(
    actor: ConfirmationActor,
    id: string,
    work: (c: PoolClient, row: Row) => Promise<T>,
  ): Promise<T> {
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
          actor.companyId,
        ])
      ).rows[0];
      const account =
        (
          await c.query<LoginCredential>(
            'SELECT id,company_id AS "companyId",display_name AS "displayName",role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword" FROM users WHERE id=$1 FOR UPDATE',
            [actor.userId],
          )
        ).rows[0] ?? null;
      const session = await lockedSession(c, actor.sessionId),
        assignments = (
          await c.query(
            "SELECT sales_staff_user_id AS staff,active,is_primary AS primary,ended_at AS ended,created_at AS created FROM customer_sales_assignments WHERE company_id=$1 FOR SHARE",
            [actor.companyId],
          )
        ).rows.filter((r) => r.active && r.primary && r.ended === null);
      const check = () => {
        draftActor(
          actor,
          account ? { ...account, companyStatus: null } : null,
          session,
          now(),
        );
        if (
          company?.status !== "ACTIVE" ||
          assignments.length !== 1 ||
          assignments[0].staff !== actor.userId ||
          assignments[0].created.getTime() > now()
        )
          throw new DraftError("forbidden");
      };
      check();
      const row = (
        await c.query(
          `SELECT ${projection} FROM orders WHERE id=$1 AND company_id=$2 AND created_by_user_id=$3 FOR UPDATE`,
          [id, actor.companyId, actor.userId],
        )
      ).rows[0];
      if (!row) throw new DraftError("not_found");
      const result = await work(c, row);
      check();
      if (broken) throw new DraftError("unavailable");
      await c.query("COMMIT");
      return result;
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
  async function existing(
    c: PoolClient,
    actor: ConfirmationActor,
    id: string,
  ): Promise<PendingConfirmation | null> {
    const r = (
      await c.query(
        'SELECT id,company_id AS "companyId",order_id AS "orderId",customer_user_id AS "customerUserId",status,created_at AS "createdAt",request_fingerprint AS fingerprint FROM order_confirmations WHERE company_id=$1 AND order_id=$2 FOR UPDATE',
        [actor.companyId, id],
      )
    ).rows[0];
    return r ? { ...r, createdAt: r.createdAt.toISOString() } : null;
  }
  return {
    find: (a, id) => run(a, id, (c) => existing(c, a, id)),
    request: (a, id, version, contact, key) =>
      run(a, id, async (c, row) => {
        const fingerprint = confirmationFingerprint(
            a,
            id,
            version,
            contact,
            key,
          ),
          prior = await existing(c, a, id);
        if (prior)
          return pendingReplay(
            prior,
            row.status,
            row.integrationStatus,
            fingerprint,
          );
        if (
          row.status !== "DRAFT" ||
          row.integrationStatus !== "NOT_SENT" ||
          row.protected
        )
          throw new DraftError("conflict");
        const draft = canonicalDraft({
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        } as Parameters<typeof canonicalDraft>[0]);
        if (draft.version !== version) throw new DraftError("conflict");
        const user = (
          await c.query(
            "SELECT id FROM users WHERE id=$1 AND company_id=$2 AND role IN ('CUSTOMER_ADMIN','CUSTOMER_USER') AND status='ACTIVE' FOR SHARE",
            [contact, a.companyId],
          )
        ).rows[0];
        if (!user) throw new DraftError("not_found");
        if (
          !row.deliveryAddressId ||
          !(
            await c.query(
              "SELECT id FROM delivery_addresses WHERE id=$1 AND company_id=$2 AND active FOR SHARE",
              [row.deliveryAddressId, a.companyId],
            )
          ).rows.length ||
          !(
            await c.query(
              "SELECT id FROM order_items WHERE company_id=$1 AND order_id=$2 LIMIT 1",
              [a.companyId, id],
            )
          ).rows.length
        )
          throw new DraftError("conflict");
        const at = nextDraftTime(draft.updatedAt, now()),
          record: PendingConfirmation = {
            id: newId(),
            companyId: a.companyId,
            orderId: id,
            customerUserId: contact,
            status: "PENDING",
            createdAt: at,
            fingerprint,
          };
        await c.query(
          "INSERT INTO order_confirmations(id,company_id,order_id,customer_user_id,status,created_at,request_fingerprint) VALUES($1,$2,$3,$4,'PENDING',$5,$6)",
          [record.id, a.companyId, id, contact, at, fingerprint],
        );
        await c.query(
          "UPDATE orders SET order_status='PENDING_CUSTOMER_CONFIRMATION',updated_at=$1 WHERE id=$2 AND company_id=$3",
          [at, id, a.companyId],
        );
        return record;
      }),
  };
}
