import type { Page, PageRequest } from "./common.js";
import type { CompanyProfile } from "./companies.js";
export interface SalesAssignment {
  readonly id: string;
  readonly companyId: string;
  readonly salesStaffUserId: string;
  readonly assignedByUserId: string;
  readonly isPrimary: boolean;
  readonly active: boolean;
  readonly createdAt: string;
  readonly endedAt: string | null;
}
/** Private current-state policy port, not an assignment administration API. */
export interface SalesAssignmentRepository {
  listAssigned(
    actor: SalesListingActor,
    page: PageRequest,
  ): Promise<Page<CompanyProfile>>;
  allows(salesStaffUserId: string, companyId: string): Promise<boolean>;
  ready(): Promise<boolean>;
}
export interface SalesListingActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessExpiresAt: string;
}
