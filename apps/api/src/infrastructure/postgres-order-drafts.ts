import { confirmedOrderApproverSql } from "./confirmed-order-owner.js";
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
import { checkedCommercialTerms } from "../services/draft-commercial.js";
import {
  checkedDraftItems,
  draftQuantity,
  requireMinimum,
} from "../services/draft-quantities.js";
import {
  draftActor,
  canonicalDraft,
  nextDraftTime,
} from "./order-draft-state.js";
import { lockedSession } from "./postgres-sessions.js";
import {
  evaluateReorder,
  materializeReorder,
} from "../services/reorder-evaluation.js";
type Row = Omit<OrderSummary, "createdAt"> & {
  createdAt: Date;
  updatedAt: Date;
  deliveryAddressId: string | null;
  protected: boolean;
  commercialBaseline: unknown;
};
const projection = `id,company_id AS "companyId",order_number AS "orderNumber",created_by_user_id AS "createdByUserId",created_at AS "createdAt",updated_at AS "updatedAt",order_status AS status,integration_status AS "integrationStatus",delivery_address_id AS "deliveryAddressId",draft_commercial_baseline AS "commercialBaseline",(submitted_at IS NOT NULL OR order_snapshot IS NOT NULL OR erp_order_reference IS NOT NULL OR idempotency_key IS NOT NULL) AS protected`;
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
      if (actor.role === "SALES_STAFF") {
        const rows = (
          await client.query(
            "SELECT sales_staff_user_id AS staff,active,is_primary AS primary,ended_at AS ended,created_at AS created FROM customer_sales_assignments WHERE company_id=$1 FOR SHARE",
            [actor.companyId],
          )
        ).rows;
        const active = rows.filter(
          (r) => r.active && r.primary && r.ended === null,
        );
        if (
          company?.status !== "ACTIVE" ||
          active.length !== 1 ||
          active[0].staff !== actor.userId ||
          active[0].created.getTime() > now()
        )
          throw new DraftError("forbidden");
      }
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
  async function items(client: PoolClient, actor: DraftActor, id: string) {
    return checkedDraftItems(
      (
        await client.query(
          'SELECT id,product_id AS "productId",quantity::text FROM order_items WHERE order_id=$1 AND company_id=$2 ORDER BY id LIMIT 101',
          [id, actor.companyId],
        )
      ).rows,
    );
  }
  return {
    reorder: (actor, id, catalog) =>
      run(actor, async (client) => {
        const source = (
          await client.query(
            `SELECT id, company_id AS "companyId", created_by_user_id AS "creatorId", order_status AS status, order_snapshot AS snapshot, ${confirmedOrderApproverSql} AS "confirmedByUserId" FROM orders WHERE id=$1 AND company_id=$2 FOR UPDATE`,
            [id, actor.companyId],
          )
        ).rows[0];
        if (!source || source.status === "DRAFT")
          throw new DraftError("not_found");
        if (!source.snapshot) throw new DraftError("conflict");
        const customer = (
          await client.query(
            "SELECT erp_customer_reference AS reference FROM companies WHERE id=$1",
            [actor.companyId],
          )
        ).rows[0];
        if (!customer?.reference) throw new DraftError("unavailable");
        const ids = source.snapshot.items?.map(
          (item: { productId: string }) => item.productId,
        );
        if (!Array.isArray(ids) || ids.length > 100)
          throw new DraftError("unavailable");
        const persisted = await items(client, actor, id);
        if (
          persisted.length !== source.snapshot.items.length ||
          source.snapshot.items.some(
            (line: { itemId: string; productId: string; quantity: string }) =>
              !persisted.some(
                (item) =>
                  item.id === line.itemId &&
                  item.productId === line.productId &&
                  item.quantity === line.quantity,
              ),
          )
        )
          throw new DraftError("unavailable");
        const products = (
          await client.query(
            "SELECT id, erp_product_reference AS reference, active FROM products WHERE id=ANY($1::uuid[]) FOR SHARE",
            [ids],
          )
        ).rows;
        const access = (
          await client.query(
            "SELECT product_id AS id, eligible FROM customer_product_access WHERE product_id=ANY($1::uuid[]) AND company_id=$2 FOR SHARE",
            [ids, actor.companyId],
          )
        ).rows;
        const refs = products.map((p) => ({
          id: p.id,
          reference: p.reference,
          eligible: p.active && access.some((a) => a.id === p.id && a.eligible),
        }));
        const result = materializeReorder(
          evaluateReorder(
            source.snapshot,
            actor.companyId,
            id,
            source.creatorId,
            customer.reference,
            refs,
            catalog,
            now(),
            source.confirmedByUserId,
          ),
          newId,
        );
        const time = new Date(now()).toISOString();
        const row = (
          await client.query<Row>(
            `INSERT INTO orders(id,company_id,created_by_user_id,delivery_address_id,order_status,integration_status,created_at,updated_at) VALUES($1,$2,$3,NULL,'DRAFT','NOT_SENT',$4,$4) RETURNING ${projection}`,
            [newId(), actor.companyId, actor.userId, time],
          )
        ).rows[0];
        if (!row) throw new DraftError("unavailable");
        for (const item of result.items)
          await client.query(
            "INSERT INTO order_items(id,company_id,order_id,product_id,quantity) VALUES($1,$2,$3,$4,$5)",
            [item.id, actor.companyId, row.id, item.productId, item.quantity],
          );
        return { draft: view(row), ...result };
      }),
    acknowledgeTerms: (actor, id, version, terms) =>
      run(actor, async (client) => {
        const row = await owned(client, actor, id);
        if (!row) throw new DraftError("not_found");
        if (!editable(row) || view(row).version !== version)
          throw new DraftError("conflict");
        const checked = checkedCommercialTerms(terms),
          lines = await items(client, actor, id);
        if (
          checked.length !== lines.length ||
          checked.some(
            (term, i) =>
              term.itemId !== lines[i]?.id ||
              term.productId !== lines[i]?.productId ||
              term.quantity !== lines[i]?.quantity,
          )
        )
          throw new DraftError("conflict");
        const updated = (
          await client.query<Row>(
            `UPDATE orders SET draft_commercial_baseline=$1::jsonb,updated_at=$2 WHERE id=$3 RETURNING ${projection}`,
            [
              JSON.stringify(checked),
              nextDraftTime(row.updatedAt.toISOString(), now()),
              id,
            ],
          )
        ).rows[0];
        if (!updated) throw new DraftError("unavailable");
        return view(updated);
      }),
    validationContext: (actor, id, version) =>
      run(actor, async (client) => {
        const row = await owned(client, actor, id);
        if (!row) throw new DraftError("not_found");
        if (!editable(row)) throw new DraftError("conflict");
        const draft = view(row);
        if (draft.version !== version) throw new DraftError("conflict");
        const customer = (
          await client.query(
            'SELECT erp_customer_reference AS "reference" FROM companies WHERE id=$1',
            [actor.companyId],
          )
        ).rows[0];
        const addressEligible =
          row.deliveryAddressId !== null &&
          (
            await client.query(
              "SELECT id FROM delivery_addresses WHERE id=$1 AND company_id=$2 AND active FOR SHARE",
              [row.deliveryAddressId, actor.companyId],
            )
          ).rows.length > 0;
        const lines = await items(client, actor, id);
        const refs = (
          await client.query(
            'SELECT id, erp_product_reference AS "reference" FROM products WHERE id=ANY($1::uuid[]) FOR SHARE',
            [lines.map((line) => line.productId)],
          )
        ).rows;
        return {
          draft,
          customerReference: customer?.reference ?? null,
          addressEligible,
          commercialBaseline:
            row.commercialBaseline === null
              ? null
              : checkedCommercialTerms(row.commercialBaseline),
          lines: lines.map((line) => ({
            ...line,
            productReference:
              refs.find((ref) => ref.id === line.productId)?.reference ?? null,
          })),
        };
      }),
    items: (actor, id) =>
      run(actor, async (client) => {
        const row = await owned(client, actor, id);
        if (!row || !editable(row)) throw new DraftError("not_found");
        return { draft: view(row), items: await items(client, actor, id) };
      }),
    changeItem: (actor, id, version, change) =>
      run(actor, async (client) => {
        const row = await owned(client, actor, id);
        if (!row) throw new DraftError("not_found");
        if (!editable(row) || view(row).version !== version)
          throw new DraftError("conflict");
        const current = await items(client, actor, id);
        const item =
          change.kind === "add"
            ? null
            : current.find((r) => r.id === change.itemId);
        if (change.kind !== "add" && !item) throw new DraftError("not_found");
        if (
          change.kind === "add" &&
          (current.length >= 100 ||
            current.some((r) => r.productId === change.productId))
        )
          throw new DraftError("conflict");
        // Retain legacy/private line evidence rather than overwrite or delete it.
        if (
          change.kind !== "add" &&
          (
            await client.query(
              "SELECT id FROM order_items WHERE id=$1 AND order_id=$2 AND company_id=$3 AND (item_snapshot IS NOT NULL OR unit_price IS NOT NULL OR line_total IS NOT NULL)",
              [change.itemId, id, actor.companyId],
            )
          ).rows.length
        )
          throw new DraftError("conflict");
        if (change.kind !== "remove") {
          const productId =
            change.kind === "add" ? change.productId : item!.productId;
          const product = (
            await client.query(
              "SELECT p.minimum_order_quantity::text AS minimum FROM products p JOIN customer_product_access a ON a.product_id=p.id AND a.company_id=$2 AND a.eligible WHERE p.id=$1 AND p.active FOR SHARE OF p,a",
              [productId, actor.companyId],
            )
          ).rows[0];
          if (!product) throw new DraftError("not_found");
          const quantity = draftQuantity(change.quantity);
          requireMinimum(quantity, product.minimum);
          if (change.kind === "add")
            await client.query(
              "INSERT INTO order_items(id,company_id,order_id,product_id,quantity) VALUES($1,$2,$3,$4,$5)",
              [newId(), actor.companyId, id, productId, quantity],
            );
          else
            await client.query(
              "UPDATE order_items SET quantity=$1 WHERE id=$2 AND order_id=$3 AND company_id=$4",
              [quantity, change.itemId, id, actor.companyId],
            );
        } else
          await client.query(
            "DELETE FROM order_items WHERE id=$1 AND order_id=$2 AND company_id=$3",
            [change.itemId, id, actor.companyId],
          );
        const updated = (
          await client.query<Row>(
            `UPDATE orders SET updated_at=$1 WHERE id=$2 RETURNING ${projection}`,
            [nextDraftTime(row.updatedAt.toISOString(), now()), id],
          )
        ).rows[0];
        if (!updated) throw new DraftError("unavailable");
        return { draft: view(updated), items: await items(client, actor, id) };
      }),
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
