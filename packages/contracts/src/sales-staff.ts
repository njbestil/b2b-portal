export interface SalesStaffResult {
  readonly user: {
    readonly id: string;
    readonly companyId: null;
    readonly displayName: string;
    readonly email: string | null;
    readonly role: "SALES_STAFF";
    readonly status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
    readonly mustChangePassword: boolean;
  };
}
