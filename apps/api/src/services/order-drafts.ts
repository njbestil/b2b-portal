import { draftQuantity, checkedDraftItems } from "./draft-quantities.js";
import { validateSubmission } from "./submission-validation.js";
import type { CatalogSource } from "../repositories/catalog-sync.js";
import type {
  DraftItems,
  DraftItemChange,
  DraftActor,
  OrderDraft,
  OrderDraftRepository,
} from "../repositories/order-drafts.js";
import type { AuditInput } from "../repositories/audit.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
export class DraftError extends Error {
  constructor(
    readonly code:
      | "invalid_quantity"
      | "invalid_input"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "unavailable",
  ) {
    super("Draft order operation could not be confirmed.");
    this.name = "DraftError";
  }
}
export function draftId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
  )
    throw new DraftError("invalid_input");
  return value.toLowerCase();
}
function version(value: unknown): string {
  if (typeof value !== "string" || !/^draft-[\da-f]{64}$/.test(value))
    throw new DraftError("invalid_input");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DraftError("invalid_input");
  return value as Record<string, unknown>;
}
const address = (value: unknown) => (value === null ? null : draftId(value));
function identity(actor: AuthorizedActor, read = false): DraftActor {
  requirePermission(actor, read ? "order-drafts.read" : "order-drafts.manage");
  if (actor.role !== "CUSTOMER_ADMIN" && actor.role !== "CUSTOMER_USER")
    throw new DraftError("forbidden");
  return {
    userId: actor.userId,
    sessionId: actor.sessionId,
    role: actor.role,
    companyId: draftId(actor.companyId),
    accessExpiresAt: actor.accessExpiresAt,
  };
}
function view(row: OrderDraft, actor: DraftActor, id?: string): OrderDraft {
  if (
    !row ||
    row.companyId !== actor.companyId ||
    row.createdByUserId !== actor.userId ||
    (id !== undefined && row.id !== id) ||
    row.status !== "DRAFT" ||
    row.integrationStatus !== "NOT_SENT" ||
    typeof row.version !== "string" ||
    !/^draft-[\da-f]{64}$/.test(row.version)
  )
    throw new DraftError("unavailable");
  return {
    id: row.id,
    companyId: row.companyId,
    createdByUserId: row.createdByUserId,
    orderNumber: row.orderNumber,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
    integrationStatus: row.integrationStatus,
    deliveryAddressId: row.deliveryAddressId,
    version: row.version,
  };
}
export function createOrderDrafts(
  repository: OrderDraftRepository,
  audit: (input: AuditInput) => Promise<unknown>,
  validation?: {
    readonly minimum: { readonly amount: string; readonly currency: string };
    readonly source: CatalogSource;
  },
) {
  async function record(
    actor: DraftActor,
    id: string,
    action: string,
    requestId: string,
  ) {
    try {
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action,
        targetType: "order",
        targetId: id,
        metadata: { requestId, orderId: id, outcome: "success" },
      });
    } catch {
      throw new DraftError("unavailable");
    }
  }
  const itemView = (
    result: DraftItems,
    who: DraftActor,
    id: string,
  ): DraftItems => ({
    draft: view(result.draft, who, id),
    items: checkedDraftItems(result.items),
  });
  return {
    async validate(actor: AuthorizedActor, key: unknown, input: unknown) {
      const who = identity(actor),
        id = draftId(key),
        body = object(input);
      if (Object.keys(body).join(",") !== "version")
        throw new DraftError("invalid_input");
      const expected = version(body.version);
      const context = await repository.validationContext(who, id, expected);
      if (
        !validation ||
        !context.customerReference ||
        context.lines.some((line) => !line.productReference)
      )
        throw new DraftError("unavailable");
      let snapshot;
      try {
        snapshot = await validation.source.readSnapshot(
          new AbortController().signal,
        );
      } catch {
        throw new DraftError("unavailable");
      }
      const current = await repository.validationContext(who, id, expected);
      if (JSON.stringify(context) !== JSON.stringify(current))
        throw new DraftError("conflict");
      const at = Date.now(),
        customer = context.customerReference;
      const valid = (p: { validFrom: string | null; validTo: string | null }) =>
        (p.validFrom === null || Date.parse(p.validFrom) <= at) &&
        (p.validTo === null || at < Date.parse(p.validTo));
      try {
        const issues = validateSubmission({
          minimum: validation.minimum,
          accountEligible: snapshot.customers.some(
            (c) => c.reference === customer && c.active,
          ),
          addressEligible: context.addressEligible,
          lines: context.lines.map((line) => {
            const product = snapshot.products.find(
              (p) => p.reference === line.productReference && p.active,
            );
            const eligible = snapshot.access.some(
              (a) =>
                a.customerReference === customer &&
                a.productReference === line.productReference &&
                a.eligible,
            );
            if (!product || !eligible)
              return { id: line.id, quantity: line.quantity, product: null };
            const prices = snapshot.prices.filter(
              (p) =>
                p.productReference === line.productReference && valid(p.price),
            );
            const price =
              prices.find((p) => p.customerReference === customer)?.price ??
              prices.find((p) => p.customerReference === null)?.price ??
              null;
            return {
              id: line.id,
              quantity: line.quantity,
              product: {
                sellingUom: product.sellingUom,
                minimumOrderQuantity: product.minimumOrderQuantity,
                availableQuantity: product.metadata?.availableQuantity ?? null,
                price: price && {
                  amount: price.amount,
                  currency: price.currency,
                },
              },
            };
          }),
        });
        return { draftVersion: expected, valid: issues.length === 0, issues };
      } catch {
        throw new DraftError("unavailable");
      }
    },
    async items(actor: AuthorizedActor, key: unknown) {
      const who = identity(actor, true),
        id = draftId(key);
      return itemView(await repository.items(who, id), who, id);
    },
    async changeItem(
      actor: AuthorizedActor,
      key: unknown,
      itemKey: unknown,
      kind: "add" | "update" | "remove",
      input: unknown,
      requestId: string,
    ) {
      const who = identity(actor),
        id = draftId(key),
        body = object(input);
      const keys =
        kind === "add"
          ? "productId,quantity,version"
          : kind === "update"
            ? "quantity,version"
            : "version";
      if (Object.keys(body).sort().join(",") !== keys)
        throw new DraftError("invalid_input");
      const change: DraftItemChange =
        kind === "add"
          ? {
              kind,
              productId: draftId(body.productId),
              quantity: draftQuantity(body.quantity),
            }
          : kind === "update"
            ? {
                kind,
                itemId: draftId(itemKey),
                quantity: draftQuantity(body.quantity),
              }
            : { kind, itemId: draftId(itemKey) };
      const result = itemView(
        await repository.changeItem(who, id, version(body.version), change),
        who,
        id,
      );
      await record(
        who,
        id,
        "order.draft_item_" +
          (kind === "add"
            ? "added"
            : kind === "update"
              ? "updated"
              : "removed"),
        requestId,
      );
      return result;
    },
    async create(actor: AuthorizedActor, input: unknown, requestId: string) {
      const who = identity(actor),
        body = object(input);
      if (Object.keys(body).some((k) => k !== "deliveryAddressId"))
        throw new DraftError("invalid_input");
      const row = view(
        await repository.create(
          who,
          Object.hasOwn(body, "deliveryAddressId")
            ? address(body.deliveryAddressId)
            : null,
        ),
        who,
      );
      await record(who, row.id, "order.created", requestId);
      return { draft: row };
    },
    async find(actor: AuthorizedActor, key: unknown) {
      const who = identity(actor, true),
        id = draftId(key),
        row = await repository.find(who, id);
      if (!row) throw new DraftError("not_found");
      return { draft: view(row, who, id) };
    },
    async update(
      actor: AuthorizedActor,
      key: unknown,
      input: unknown,
      requestId: string,
    ) {
      const who = identity(actor),
        id = draftId(key),
        body = object(input);
      if (Object.keys(body).sort().join(",") !== "deliveryAddressId,version")
        throw new DraftError("invalid_input");
      const row = view(
        await repository.update(
          who,
          id,
          version(body.version),
          address(body.deliveryAddressId),
        ),
        who,
        id,
      );
      await record(who, id, "order.draft_updated", requestId);
      return { draft: row };
    },
    async remove(
      actor: AuthorizedActor,
      key: unknown,
      input: unknown,
      requestId: string,
    ) {
      const who = identity(actor),
        id = draftId(key),
        body = object(input);
      if (Object.keys(body).join(",") !== "version")
        throw new DraftError("invalid_input");
      await repository.remove(who, id, version(body.version));
      await record(who, id, "order.draft_deleted", requestId);
      return { deleted: true as const, draftId: id };
    },
  };
}
export type OrderDraftService = ReturnType<typeof createOrderDrafts>;
