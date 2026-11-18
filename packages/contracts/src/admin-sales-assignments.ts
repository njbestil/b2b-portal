export interface AdminSalesAssignmentResult {
  readonly assignment: {
    readonly id: string;
    readonly companyId: string;
    readonly salesStaffUserId: string;
    readonly assignedByUserId: string;
    readonly isPrimary: boolean;
    readonly active: boolean;
    readonly createdAt: string;
    readonly endedAt: string | null;
  } | null;
}
