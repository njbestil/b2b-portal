export interface CustomerUserResult {
  readonly user: {
    readonly id: string;
    readonly companyId: string;
    readonly displayName: string;
    readonly email: string | null;
    readonly role: "CUSTOMER_USER";
    readonly status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
    readonly mustChangePassword: boolean;
  };
}
