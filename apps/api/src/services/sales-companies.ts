import type { SalesAssignmentRepository } from "../repositories/sales-assignments.js";
import type { PageRequest } from "../repositories/common.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import {
  assignmentId,
  checkedSalesPage,
  SalesAssignmentError,
} from "./sales-assignments.js";
export function createSalesCompanies(repository: SalesAssignmentRepository) {
  return async (actor: AuthorizedActor, input?: PageRequest) => {
    requirePermission(actor, "sales.companies.read");
    const page = checkedSalesPage(input);
    const result = await repository.listAssigned(
      {
        userId: assignmentId(actor.userId),
        sessionId: assignmentId(actor.sessionId),
        accessExpiresAt: actor.accessExpiresAt,
      },
      page,
    );
    try {
      const ids = result.items.map((row) => assignmentId(row.id));
      if (
        !Number.isSafeInteger(result.total) ||
        result.total < 0 ||
        result.items.length > page.limit ||
        result.total < result.items.length ||
        (result.items.length &&
          page.offset + result.items.length > result.total) ||
        new Set(ids).size !== ids.length ||
        result.items.some(
          (row, i) =>
            row.status !== "ACTIVE" || (i > 0 && ids[i - 1]! >= ids[i]!),
        )
      )
        throw new Error();
    } catch {
      throw new SalesAssignmentError("unavailable");
    }
    return {
      items: result.items.map((row) => ({
        id: row.id,
        legalName: row.legalName,
        tradeName: row.tradeName,
        status: row.status,
        erpCustomerReference: row.erpCustomerReference,
      })),
      total: result.total,
      ...page,
    };
  };
}
