import type { SalesAssignment } from "./sales-assignments.js";
export interface AssignmentAdminActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessExpiresAt: string;
}
export interface AssignmentChange {
  readonly id: string;
  readonly companyId: string;
  readonly salesStaffUserId: string;
  readonly expectedAssignmentId: string | null;
}
/** Private administration capability; current Sales read/policy port stays separate. */
export interface AdminSalesAssignmentRepository {
  current(
    actor: AssignmentAdminActor,
    companyId: string,
  ): Promise<SalesAssignment | null>;
  assign(
    actor: AssignmentAdminActor,
    input: AssignmentChange,
  ): Promise<SalesAssignment>;
}
