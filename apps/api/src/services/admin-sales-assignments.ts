import type {
  AssignmentAdminActor,
  AssignmentChange,
  AdminSalesAssignmentRepository,
} from "../repositories/admin-sales-assignments.js";
import type { SalesAssignment } from "../repositories/sales-assignments.js";
import type { AuditInput } from "../repositories/audit.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import { checkedAssignments } from "./sales-assignments.js";
export class AssignmentManagementError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Sales assignment operation could not be confirmed.");
    this.name = "AssignmentManagementError";
  }
}
export function managementId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new AssignmentManagementError("invalid_input");
  return value.toLowerCase();
}
export function checkedAssignmentChange(
  value: AssignmentChange,
): AssignmentChange {
  if (!value) throw new AssignmentManagementError("invalid_input");
  return {
    id: managementId(value.id),
    companyId: managementId(value.companyId),
    salesStaffUserId: managementId(value.salesStaffUserId),
    expectedAssignmentId:
      value.expectedAssignmentId === null
        ? null
        : managementId(value.expectedAssignmentId),
  };
}
function identity(actor: AuthorizedActor): AssignmentAdminActor {
  requirePermission(actor, "sales-assignments.manage");
  return {
    userId: actor.userId,
    sessionId: actor.sessionId,
    accessExpiresAt: actor.accessExpiresAt,
  };
}
function result(row: SalesAssignment | null, companyId: string) {
  if (row === null) return { assignment: null };
  try {
    const assignment = checkedAssignments([row])[0]!;
    if (
      assignment.companyId !== companyId ||
      !assignment.active ||
      !assignment.isPrimary ||
      assignment.endedAt !== null
    )
      throw new Error();
    return {
      assignment: {
        id: assignment.id,
        companyId: assignment.companyId,
        salesStaffUserId: assignment.salesStaffUserId,
        assignedByUserId: assignment.assignedByUserId,
        isPrimary: true,
        active: true,
        createdAt: assignment.createdAt,
        endedAt: null,
      },
    };
  } catch {
    throw new AssignmentManagementError("unavailable");
  }
}
export function createAdminSalesAssignments(
  repository: AdminSalesAssignmentRepository,
  audit: (input: AuditInput) => Promise<unknown>,
  newId: () => string,
) {
  return {
    async current(actor: AuthorizedActor, companyId: unknown) {
      const who = identity(actor),
        company = managementId(companyId);
      return result(await repository.current(who, company), company);
    },
    async assign(
      actor: AuthorizedActor,
      companyId: unknown,
      value: unknown,
      requestId: string,
    ) {
      const who = identity(actor),
        company = managementId(companyId);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !==
          "expectedAssignmentId,salesStaffUserId"
      )
        throw new AssignmentManagementError("invalid_input");
      const body = value as Record<string, unknown>;
      const input = checkedAssignmentChange({
        id: newId(),
        companyId: company,
        salesStaffUserId: managementId(body.salesStaffUserId),
        expectedAssignmentId:
          body.expectedAssignmentId === null
            ? null
            : managementId(body.expectedAssignmentId),
      });
      const output = result(await repository.assign(who, input), company);
      if (
        !output.assignment ||
        output.assignment.id !== input.id ||
        output.assignment.salesStaffUserId !== input.salesStaffUserId ||
        output.assignment.assignedByUserId !== who.userId
      )
        throw new AssignmentManagementError("unavailable");
      try {
        await audit({
          companyId: company,
          actorUserId: who.userId,
          actorRole: "INTERNAL_ADMIN",
          action:
            input.expectedAssignmentId === null
              ? "sales_assignment.assigned"
              : "sales_assignment.reassigned",
          targetType: "sales_assignment",
          targetId: input.id,
          metadata: {
            requestId,
            outcome: "success",
            changedFields: ["salesStaffUserId", "active"],
          },
        });
      } catch {
        throw new AssignmentManagementError("unavailable");
      }
      return output;
    },
  };
}
export type AdminSalesAssignmentService = ReturnType<
  typeof createAdminSalesAssignments
>;
