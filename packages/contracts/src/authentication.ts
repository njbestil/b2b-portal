/** Safe user projection; credential evidence never enters public contracts. */
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
export interface SessionTokenResult extends LoginResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: "Bearer";
  readonly expiresIn: number;
  readonly refreshExpiresAt: string;
}
