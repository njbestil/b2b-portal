import { RemoteError, entityId } from "./remote";
export interface CompanyIdentity {
  companyId: string | null;
  role: string;
  mustChangePassword: boolean;
}
export type CompanyScope =
  { kind: "own" } | { kind: "internal"; companyId: string };
export interface CompanyAccess {
  scope: CompanyScope;
  companyId: string;
  canEdit: boolean;
  canSelect: boolean;
}
/** UI affordances only. API #32/#33/#34 must authorize every operation independently. */
export function companyAccess(
  identity: CompanyIdentity,
  internalCompanyId?: string,
): CompanyAccess {
  if (identity.mustChangePassword) throw new RemoteError("forbidden");
  if (identity.role === "CUSTOMER_ADMIN" || identity.role === "CUSTOMER_USER") {
    if (internalCompanyId !== undefined || !entityId(identity.companyId))
      throw new RemoteError("forbidden");
    return {
      scope: { kind: "own" },
      companyId: identity.companyId,
      canEdit: identity.role === "CUSTOMER_ADMIN",
      canSelect: true,
    };
  }
  if (
    (identity.role === "INTERNAL_ADMIN" || identity.role === "SALES_STAFF") &&
    entityId(internalCompanyId)
  )
    return {
      scope: { kind: "internal", companyId: internalCompanyId },
      companyId: internalCompanyId,
      canEdit: false,
      canSelect: identity.role === "SALES_STAFF",
    };
  throw new RemoteError("forbidden");
}
