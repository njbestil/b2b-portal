import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CatalogSource } from "../repositories/catalog-sync.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { DraftActor } from "../repositories/order-drafts.js";
import {
  requirePermission,
  type AuthorizedActor,
} from "../services/authorization.js";
import {
  checkedCommercialTerms,
  commercialDifferences,
} from "../services/draft-commercial.js";
import { checkedDraftItems } from "../services/draft-quantities.js";
import { DraftError, draftId } from "../services/order-drafts.js";
import { createOrderSnapshot } from "../services/order-snapshot.js";
import { checkedAudit } from "../services/audit.js";
import { validateSubmission } from "../services/submission-validation.js";
import { canonicalDraft, draftActor } from "./order-draft-state.js";
import { lockedSession } from "./postgres-sessions.js";
import {
  SubmissionKeyConflict,
  submitIdempotently,
} from "./postgres-submission-idempotency.js";
import { createPostgresSubmissionDispatch } from "./postgres-submission-dispatch.js";
import type {
  MockSubmissionRequest,
  MockSubmissionResult,
} from "./mock-submission-adapter.js";

export function createPostgresOrderSubmission(
  pool: Pool,
  source: CatalogSource,
  minimum: { amount: string; currency: string },
  gateway: {
    send(request: MockSubmissionRequest): Promise<MockSubmissionResult>;
  },
) {
  const dispatch = createPostgresSubmissionDispatch(pool, gateway);
  return async function submit(
    actor: AuthorizedActor,
    rawId: unknown,
    key: unknown,
    input: unknown,
  ) {
    requirePermission(actor, "order-drafts.manage");
    if (actor.role !== "CUSTOMER_ADMIN" && actor.role !== "CUSTOMER_USER")
      throw new DraftError("forbidden");
    const who: DraftActor & { role: "CUSTOMER_ADMIN" | "CUSTOMER_USER" } = {
      userId: actor.userId,
      sessionId: actor.sessionId,
      role: actor.role,
      companyId: draftId(actor.companyId),
      accessExpiresAt: actor.accessExpiresAt,
    };
    const id = draftId(rawId);
    if (
      typeof key !== "string" ||
      !/^[\x21-\x7e]{1,128}$/.test(key) ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).join(",") !== "version" ||
      typeof (input as { version?: unknown }).version !== "string" ||
      !/^draft-[\da-f]{64}$/.test((input as { version: string }).version)
    )
      throw new DraftError("invalid_input");
    const version = (input as { version: string }).version;
    let catalog: Awaited<ReturnType<CatalogSource["readSnapshot"]>> | null =
      null;
    try {
      const keyHash = createHash("sha256").update(key).digest("hex");
      const prior = await pool.query(
        "SELECT 1 FROM submission_idempotency WHERE key_hash=$1 AND company_id=$2 AND user_id=$3 AND order_id=$4",
        [keyHash, who.companyId, who.userId, id],
      );
      if (!prior.rowCount)
        catalog = await source.readSnapshot(new AbortController().signal);
    } catch {
      throw new DraftError("unavailable");
    }
    async function authorize(client: PoolClient) {
      const company = (
        await client.query(
          "SELECT status FROM companies WHERE id=$1 FOR UPDATE",
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
      draftActor(
        who,
        user
          ? {
              ...user,
              companyStatus:
                user.companyId === who.companyId
                  ? (company?.status ?? null)
                  : null,
            }
          : null,
        session,
        Date.now(),
      );
    }
    try {
      await submitIdempotently(
        pool,
        {
          key,
          companyId: who.companyId,
          userId: who.userId,
          orderId: id,
          canonicalRequest: JSON.stringify({
            schemaVersion: 1,
            orderId: id,
            version,
          }),
        },
        authorize,
        async (client, outboundReference) => {
          if (!catalog) throw new DraftError("unavailable");
          const row = (
            await client.query(
              `SELECT id,company_id AS "companyId",created_by_user_id AS "createdByUserId",order_number AS "orderNumber",created_at AS "createdAt",updated_at AS "updatedAt",order_status AS status,integration_status AS "integrationStatus",delivery_address_id AS "deliveryAddressId",draft_commercial_baseline AS baseline,order_snapshot,submitted_at,erp_order_reference,idempotency_key FROM orders WHERE id=$1 AND company_id=$2 AND created_by_user_id=$3 FOR UPDATE`,
              [id, who.companyId, who.userId],
            )
          ).rows[0];
          if (!row) throw new DraftError("not_found");
          if (
            row.order_snapshot !== null ||
            row.submitted_at !== null ||
            row.erp_order_reference !== null ||
            row.idempotency_key !== null
          )
            throw new DraftError("conflict");
          const draft = canonicalDraft({
            ...row,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          });
          if (draft.version !== version || !draft.deliveryAddressId)
            throw new DraftError("conflict");
          const company = (
            await client.query(
              "SELECT erp_customer_reference AS reference FROM companies WHERE id=$1",
              [who.companyId],
            )
          ).rows[0];
          const user = (
            await client.query(
              'SELECT display_name AS "displayName" FROM users WHERE id=$1',
              [who.userId],
            )
          ).rows[0];
          const delivery = (
            await client.query(
              `SELECT id,company_id AS "companyId",label,address->>'line1' AS line1,address->>'contactName' AS "contactName",address->>'contactPhone' AS "contactPhone" FROM delivery_addresses WHERE id=$1 AND company_id=$2 AND active FOR SHARE`,
              [draft.deliveryAddressId, who.companyId],
            )
          ).rows[0];
          if (!company?.reference || !delivery || !user)
            throw new DraftError("conflict");
          const lines = checkedDraftItems(
            (
              await client.query(
                'SELECT id,product_id AS "productId",quantity::text FROM order_items WHERE order_id=$1 AND company_id=$2 ORDER BY id FOR UPDATE',
                [id, who.companyId],
              )
            ).rows,
          );
          const refs = (
            await client.query(
              "SELECT id,erp_product_reference AS reference FROM products WHERE id=ANY($1::uuid[]) FOR SHARE",
              [lines.map((line) => line.productId)],
            )
          ).rows;
          const at = Date.now();
          const terms: {
            itemId: string;
            productId: string;
            quantity: string;
            amount: string;
            currency: string;
          }[] = [];
          const resolved = lines.map((line) => {
            const reference = refs.find(
              (r) => r.id === line.productId,
            )?.reference;
            const product = catalog.products.find(
              (p) => p.reference === reference && p.active,
            );
            const eligible = catalog.access.some(
              (a) =>
                a.customerReference === company.reference &&
                a.productReference === reference &&
                a.eligible,
            );
            if (!product || !eligible)
              return { line, reference, product: null, price: null };
            const prices = catalog.prices.filter(
              (p) =>
                p.productReference === reference &&
                (p.price.validFrom === null ||
                  Date.parse(p.price.validFrom) <= at) &&
                (p.price.validTo === null || at < Date.parse(p.price.validTo)),
            );
            const price =
              prices.find((p) => p.customerReference === company.reference)
                ?.price ??
              prices.find((p) => p.customerReference === null)?.price ??
              null;
            if (price)
              terms.push({
                itemId: line.id,
                productId: line.productId,
                quantity: line.quantity,
                amount: price.amount,
                currency: price.currency,
              });
            return { line, reference, product, price };
          });
          const issues = validateSubmission({
            minimum,
            accountEligible: catalog.customers.some(
              (c) => c.reference === company.reference && c.active,
            ),
            addressEligible: true,
            lines: resolved.map(({ line, product, price }) => ({
              id: line.id,
              quantity: line.quantity,
              product: product
                ? {
                    sellingUom: product.sellingUom,
                    minimumOrderQuantity: product.minimumOrderQuantity,
                    availableQuantity:
                      product.metadata?.availableQuantity ?? null,
                    price,
                  }
                : null,
            })),
          });
          const checked = checkedCommercialTerms(terms);
          if (
            issues.length ||
            checked.length !== lines.length ||
            !checked.length ||
            commercialDifferences(
              row.baseline === null
                ? null
                : checkedCommercialTerms(row.baseline),
              checked,
            ).length ||
            resolved.some(
              (r) =>
                !r.product ||
                !r.price ||
                !r.reference ||
                !["Piece", "Pack", "Carton", "Case", "Bag", "KG"].includes(
                  r.product.sellingUom,
                ),
            )
          )
            throw new DraftError("conflict");
          const submittedAt = new Date().toISOString();
          const snapshot = createOrderSnapshot({
            orderId: id,
            companyId: who.companyId,
            submittedAt,
            submittedBy: {
              id: who.userId,
              companyId: who.companyId,
              displayName: user.displayName,
              role: who.role,
            },
            delivery,
            items: resolved.map(({ line, product, price }) => ({
              itemId: line.id,
              productId: line.productId,
              sku: product!.sku,
              name: product!.name,
              sellingUom: product!.sellingUom,
              minimumOrderQuantity: product!.minimumOrderQuantity,
              quantity: line.quantity,
              unitPrice: price!.amount,
              currency: price!.currency,
            })),
          });
          const payload: MockSubmissionRequest = {
            externalRequestReference: outboundReference,
            portalOrderId: id,
            customerId: company.reference,
            items: resolved.map(({ line, reference, product, price }) => ({
              productId: reference,
              quantity: line.quantity,
              sellingUom: product!.sellingUom,
              unitPrice: price!.amount,
              currency: price!.currency,
              snapshot: { sku: product!.sku, name: product!.name },
            })),
          };
          if (Buffer.byteLength(JSON.stringify(payload)) > 32768)
            throw new DraftError("unavailable");
          await client.query(
            `INSERT INTO integration_transactions(id,company_id,order_id,operation,idempotency_key,status,request_payload) VALUES($1,$2,$3,'ORDER_SUBMISSION',$4,'PENDING',$5::jsonb)`,
            [
              randomUUID(),
              who.companyId,
              id,
              outboundReference,
              JSON.stringify(payload),
            ],
          );
          const audit = checkedAudit({
            id: randomUUID(),
            companyId: who.companyId,
            actorUserId: who.userId,
            actorRole: who.role,
            action: "order.submitted",
            targetType: "order",
            targetId: id,
            metadata: { orderId: id, outcome: "success" },
            createdAt: submittedAt,
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
          await client.query(
            "UPDATE orders SET order_status='SUBMITTED',integration_status='PENDING',submitted_at=$1,updated_at=$1 WHERE id=$2 AND company_id=$3",
            [submittedAt, id, who.companyId],
          );
          return snapshot;
        },
      );
      await dispatch(who.companyId, id);
      return { orderId: id };
    } catch (error) {
      if (error instanceof SubmissionKeyConflict)
        throw new DraftError("conflict");
      if (error instanceof DraftError) throw error;
      throw new DraftError("unavailable");
    }
  };
}
export type OrderSubmission = ReturnType<typeof createPostgresOrderSubmission>;
