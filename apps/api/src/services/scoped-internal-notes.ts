import type {
  InternalNotesRepository,
  NoteActor,
} from "../repositories/internal-notes.js";
import type { SalesAssignmentRepository } from "../repositories/sales-assignments.js";
import type { PageRequest } from "../repositories/common.js";
import { createInternalNotes } from "./internal-notes.js";
import {
  requirePermission,
  AuthorizationError,
  type AuthorizedActor,
} from "./authorization.js";
import { assignmentId, createSalesScope } from "./sales-assignments.js";
/** Bridge the existing mandatory note callback to actual validated backend actor
 * and current assignment evidence. This is not a customer/HTTP note route. */
export function createScopedInternalNotes(
  repository: InternalNotesRepository,
  assignments: SalesAssignmentRepository,
  newId: () => string,
  now: () => Date = () => new Date(),
) {
  async function scoped(actor: AuthorizedActor, companyId: unknown) {
    requirePermission(actor, "orders.read");
    if (!["INTERNAL_ADMIN", "SALES_STAFF"].includes(actor.role))
      throw new AuthorizationError();
    const company = assignmentId(companyId);
    const identity: NoteActor = {
      id: actor.userId,
      role: actor.role,
      status: "ACTIVE",
    };
    const service = createInternalNotes(
      repository,
      async (noteActor, scope) => {
        requirePermission(actor, "orders.read");
        if (
          noteActor.id !== actor.userId ||
          noteActor.role !== actor.role ||
          scope.companyId !== company
        )
          return false;
        if (actor.role === "INTERNAL_ADMIN") return true;
        await createSalesScope(assignments)(actor, company, "orders.read");
        return true;
      },
      newId,
      now,
    );
    return { service, identity, scope: { companyId: company } };
  }
  return {
    async add(
      actor: AuthorizedActor,
      companyId: unknown,
      orderId: string,
      note: string,
    ) {
      const access = await scoped(actor, companyId);
      return access.service.add(access.identity, access.scope, orderId, note);
    },
    async list(
      actor: AuthorizedActor,
      companyId: unknown,
      orderId: string,
      page?: PageRequest,
    ) {
      const access = await scoped(actor, companyId);
      return access.service.list(access.identity, access.scope, orderId, page);
    },
  };
}
