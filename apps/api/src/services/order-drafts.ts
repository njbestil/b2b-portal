import type {
  DraftActor,
  OrderDraft,
  OrderDraftRepository,
} from "../repositories/order-drafts.js";
import type { AuditInput } from "../repositories/audit.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
export class DraftError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable",
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
  return {
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
