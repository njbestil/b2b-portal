import { randomUUID } from "node:crypto";
import type { OrderNotesRepository } from "../repositories/order-notes.js";
import type { AuditInput } from "../repositories/audit.js";
import {
  createInternalNotes,
  InternalNoteError,
  noteId,
} from "./internal-notes.js";
import {
  requirePermission,
  AuthorizationError,
  type AuthorizedActor,
} from "./authorization.js";
import { checkedSalesPage } from "./sales-assignments.js";
export function createOrderNotes(
  repository: OrderNotesRepository,
  audit: (event: AuditInput) => Promise<unknown>,
) {
  async function access<T>(
    actor: AuthorizedActor,
    company: unknown,
    operation: (
      service: ReturnType<typeof createInternalNotes>,
      identity: { id: string; role: AuthorizedActor["role"]; status: string },
      scope: { companyId: string },
    ) => Promise<T>,
  ) {
    requirePermission(actor, "orders.read");
    if (!["INTERNAL_ADMIN", "SALES_STAFF"].includes(actor.role))
      throw new AuthorizationError();
    const companyId = noteId(company as string),
      identity = { id: actor.userId, role: actor.role, status: "ACTIVE" };
    return repository.run(actor, companyId, async (notes) => {
      const service = createInternalNotes(
        notes,
        async (author, scope) => {
          // The provider holds current authority; bind the lower-level callback
          // to that exact actor/company rather than admitting arbitrary scopes.
          requirePermission(actor, "orders.read");
          return (
            author.id === actor.userId &&
            author.role === actor.role &&
            scope.companyId === companyId
          );
        },
        randomUUID,
      );
      return operation(service, identity, { companyId });
    });
  }
  return {
    async add(
      actor: AuthorizedActor,
      company: unknown,
      order: unknown,
      input: unknown,
      requestId: string,
    ) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).join(",") !== "note" ||
        typeof (input as { note?: unknown }).note !== "string"
      )
        throw new InternalNoteError("invalid_note");
      const orderId = noteId(order as string),
        note = (input as { note: string }).note;
      const result = await access(actor, company, (s, a, scope) =>
        s.add(a, scope, orderId, note),
      );
      try {
        await audit({
          companyId: result.companyId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: "order.internal_note_added",
          targetType: "order",
          targetId: orderId,
          metadata: { requestId, orderId, outcome: "success" },
        });
      } catch {
        throw new InternalNoteError("storage_failed");
      }
      return { note: result };
    },
    async list(
      actor: AuthorizedActor,
      company: unknown,
      order: unknown,
      page: { offset: number; limit: number },
    ) {
      const orderId = noteId(order as string),
        request = checkedSalesPage(page);
      return access(actor, company, (s, a, scope) =>
        s.list(a, scope, orderId, request),
      );
    },
  };
}
export type OrderNotesService = ReturnType<typeof createOrderNotes>;
