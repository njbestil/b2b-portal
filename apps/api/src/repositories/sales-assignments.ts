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
  allows(salesStaffUserId: string, companyId: string): Promise<boolean>;
  ready(): Promise<boolean>;
}
