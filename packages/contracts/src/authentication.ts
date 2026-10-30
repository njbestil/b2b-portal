/** Credential verification result only. Session issuance belongs to B2B-016. */
export interface LoginResult {
  readonly user: {
    readonly id: string;
    readonly companyId: string | null;
    readonly displayName: string;
    readonly role:
      "INTERNAL_ADMIN" | "SALES_STAFF" | "CUSTOMER_ADMIN" | "CUSTOMER_USER";
    readonly mustChangePassword: boolean;
  };
}
