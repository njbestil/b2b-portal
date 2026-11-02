import type {
  SalesAssignment,
  SalesAssignmentRepository,
} from "../repositories/sales-assignments.js";
import type { CompanyScope } from "../repositories/common.js";
import {
  requirePermission,
  AuthorizationError,
  type AuthorizedActor,
  type Permission,
} from "./authorization.js";
export class SalesAssignmentError extends Error {
  constructor(readonly code: "invalid_input" | "unavailable") {
    super("Sales assignment could not be confirmed.");
    this.name = "SalesAssignmentError";
  }
}
export function assignmentId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new SalesAssignmentError("invalid_input");
  return value.toLowerCase();
}
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
/** Logical constraints mirror the existing SQL indexes and checks. */
export function checkedAssignments(input: unknown): SalesAssignment[] {
  if (!Array.isArray(input) || input.length > 10000)
    throw new SalesAssignmentError("unavailable");
  const ids = new Set<string>(),
    primary = new Set<string>(),
    pairs = new Set<string>();
  return Array.from(input, (r: SalesAssignment) => {
    if (
      !r ||
      typeof r !== "object" ||
      Array.isArray(r) ||
      Object.keys(r).sort().join(",") !==
        "active,assignedByUserId,companyId,createdAt,endedAt,id,isPrimary,salesStaffUserId" ||
      typeof r.active !== "boolean" ||
      typeof r.isPrimary !== "boolean" ||
      !timestamp(r.createdAt) ||
      !(
        r.endedAt === null ||
        (timestamp(r.endedAt) && r.endedAt >= r.createdAt)
      ) ||
      (r.active && r.endedAt !== null)
    )
      throw new SalesAssignmentError("unavailable");
    const row = {
      ...r,
      id: assignmentId(r.id),
      companyId: assignmentId(r.companyId),
      salesStaffUserId: assignmentId(r.salesStaffUserId),
      assignedByUserId: assignmentId(r.assignedByUserId),
    };
    const pair = row.companyId + "/" + row.salesStaffUserId;
    if (
      ids.has(row.id) ||
      (row.active && pairs.has(pair)) ||
      (row.active && row.isPrimary && primary.has(row.companyId))
    )
      throw new SalesAssignmentError("unavailable");
    ids.add(row.id);
    if (row.active) {
      pairs.add(pair);
      if (row.isPrimary) primary.add(row.companyId);
    }
    return row;
  });
}
export function createSalesScope(repository: SalesAssignmentRepository) {
  return async (
    actor: AuthorizedActor,
    companyId: unknown,
    permission: Permission = "company.read",
  ): Promise<CompanyScope> => {
    requirePermission(actor, permission);
    if (actor.role !== "SALES_STAFF") throw new AuthorizationError();
    const company = assignmentId(companyId);
    if (!(await repository.allows(actor.userId, company)))
      throw new AuthorizationError();
    return Object.freeze({ companyId: company });
  };
}
