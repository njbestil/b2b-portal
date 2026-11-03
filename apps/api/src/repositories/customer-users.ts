export interface CustomerUserActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly companyId: string;
  readonly accessExpiresAt: string;
}
export interface NewCustomerUser {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly passwordHash: string;
}
export interface ManagedCustomerUser {
  readonly id: string;
  readonly companyId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly role: "CUSTOMER_USER";
  readonly status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  readonly mustChangePassword: boolean;
}
export interface CustomerUserRepository {
  create(
    actor: CustomerUserActor,
    input: NewCustomerUser,
  ): Promise<ManagedCustomerUser>;
  deactivate(
    actor: CustomerUserActor,
    id: string,
    expectedStatus: "ACTIVE" | "SUSPENDED",
  ): Promise<ManagedCustomerUser>;
}
