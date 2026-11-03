import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  DraftActor,
  OrderDraftRepository,
} from "../repositories/order-drafts.js";
import type { OrderSummary } from "../repositories/orders.js";
import type { LoginCredential } from "../repositories/authentication.js";
import { DraftError } from "../services/order-drafts.js";
import { SessionError } from "../services/session-state.js";
import {
  draftActor,
  canonicalDraft,
  nextDraftTime,
} from "./order-draft-state.js";
import { lockedSession } from "./postgres-sessions.js";
type Row = Omit<OrderSummary, "createdAt"> & {
  createdAt: Date;
  updatedAt: Date;
  deliveryAddressId: string | null;
  protected: boolean;
};
const projection = `id,company_id AS "companyId",order_number AS "orderNumber",created_by_user_id AS "createdByUserId",created_at AS "createdAt",updated_at AS "updatedAt",order_status AS status,integration_status AS "integrationStatus",delivery_address_id AS "deliveryAddressId",(submitted_at IS NOT NULL OR order_snapshot IS NOT NULL OR erp_order_reference IS NOT NULL OR idempotency_key IS NOT NULL) AS protected`;
const view = (row: Row) =>
  canonicalDraft({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
const editable = (row: Row) =>
  row.status === "DRAFT" &&
  row.integrationStatus === "NOT_SENT" &&
  !row.protected;
export function createPostgresOrderDrafts(
  pool: Pool,
  now = Date.now,
  newId = randomUUID,
): OrderDraftRepository {
  async function run<T>(
    actor: DraftActor,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw new DraftError("unavailable");
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
        await client.query(
          "SELECT status FROM companies WHERE id=$1 FOR UPDATE",
          [actor.companyId],
        )
      ).rows[0];
      const user = (
          await client.query<LoginCredential>(
            'SELECT id,company_id AS "companyId",display_name AS "displayName",role,status,password_hash AS "passwordHash",must_change_password AS "mustChangePassword" FROM users WHERE id=$1 FOR UPDATE',
            [actor.userId],
          )
        ).rows[0],
        account = user
          ? {
              ...user,
              companyStatus:
                user.companyId === actor.companyId
                  ? (company?.status ?? null)
                  : null,
            }
          : null;
      const session = await lockedSession(client, actor.sessionId);
      const check = () => draftActor(actor, account, session, now());
      check();
      const result = await work(client);
      check();
      if (broken) throw new DraftError("unavailable");
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      if (e instanceof DraftError || e instanceof SessionError) throw e;
      if (
        e &&
        typeof e === "object" &&
        "code" in e &&
        (e.code === "23503" || e.code === "23505")
      )
        throw new DraftError("conflict");
      throw new DraftError("unavailable");
    } finally {
      client.off("error", onError);
      client.release(broken);
    }
  }
  async function owned(client: PoolClient, actor: DraftActor, id: string) {
    return (
      (
        await client.query<Row>(
          `SELECT ${projection} FROM orders WHERE id=$1 AND company_id=$2 AND created_by_user_id=$3 FOR UPDATE`,
          [id, actor.companyId, actor.userId],
        )
      ).rows[0] ?? null
    );
  }
  async function address(
    client: PoolClient,
    actor: DraftActor,
    id: string | null,
  ) {
    if (id === null) return;
    if (
      !(
        await client.query(
          "SELECT id FROM delivery_addresses WHERE id=$1 AND company_id=$2 AND active FOR SHARE",
          [id, actor.companyId],
        )
      ).rows.length
    )
      throw new DraftError("not_found");
  }
  return {
    create: (actor, addressId) =>
      run(actor, async (client) => {
        await address(client, actor, addressId);
        const time = new Date(now()).toISOString();
        const row = (
          await client.query<Row>(
            `INSERT INTO orders(id,company_id,created_by_user_id,delivery_address_id,order_status,integration_status,created_at,updated_at) VALUES($1,$2,$3,$4,'DRAFT','NOT_SENT',$5,$5) RETURNING ${projection}`,
            [newId(), actor.companyId, actor.userId, addressId, time],
          )
        ).rows[0];
        if (!row) throw new DraftError("unavailable");
        return view(row);
      }),
    find: (actor, id) =>
      run(actor, async (client) => {
        const row = await owned(client, actor, id);
        return row && editable(row) ? view(row) : null;
      }),
    update: (actor, id, version, addressId) =>
      run(actor, async (client) => {
        const row = await owned(client, actor, id);
        if (!row) throw new DraftError("not_found");
        if (!editable(row) || view(row).version !== version)
          throw new DraftError("conflict");
        await address(client, actor, addressId);
        const updated = (
          await client.query<Row>(
            `UPDATE orders SET delivery_address_id=$1,updated_at=$2 WHERE id=$3 RETURNING ${projection}`,
            [addressId, nextDraftTime(row.updatedAt.toISOString(), now()), id],
          )
        ).rows[0];
        if (!updated) throw new DraftError("unavailable");
        return view(updated);
      }),
    remove: (actor, id, version) =>
      run(actor, async (client) => {
        const row = await owned(client, actor, id);
        if (!row) throw new DraftError("not_found");
        if (!editable(row) || view(row).version !== version)
          throw new DraftError("conflict");
        await client.query("DELETE FROM orders WHERE id=$1", [id]);
      }),
  };
}
