export interface SalesStaffActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessExpiresAt: string;
}
export interface NewSalesStaff {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly passwordHash: string;
}
export interface ManagedSalesStaff {
  readonly id: string;
  readonly companyId: null;
  readonly displayName: string;
  readonly email: string | null;
  readonly role: "SALES_STAFF";
  readonly status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  readonly mustChangePassword: boolean;
}
export interface SalesStaffRepository {
  create(
    actor: SalesStaffActor,
    input: NewSalesStaff,
  ): Promise<ManagedSalesStaff>;
  change(
    actor: SalesStaffActor,
    id: string,
    expectedStatus: "ACTIVE" | "SUSPENDED" | "DEACTIVATED",
    nextStatus: "ACTIVE" | "DEACTIVATED",
  ): Promise<ManagedSalesStaff>;
}
