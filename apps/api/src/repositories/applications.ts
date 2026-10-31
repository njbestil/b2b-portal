export interface ApplicationFields {
  readonly companyName: string;
  readonly tradeLicenseReference: string;
  readonly businessEmail: string;
  readonly phone: string;
  readonly billingAddress: string;
  readonly deliveryAddress: string;
  readonly administratorName: string;
  readonly administratorEmail: string;
  readonly administratorMobile: string;
}
/** Private persistence command. No plaintext credential or client-controlled state. */
export interface ApplicationRecord extends ApplicationFields {
  readonly companyId: string;
  readonly administratorUserId: string;
  readonly deliveryAddressId: string;
  readonly passwordHash: string;
  readonly createdAt: string;
}
export interface PendingApplication extends ApplicationFields {
  readonly createdAt: string;
  readonly companyId: string;
  readonly administratorUserId: string;
  readonly deliveryAddressId: string;
}
export interface ApplicationRepository {
  submit(record: ApplicationRecord): Promise<{ companyId: string | null }>;
  /** Backend-only complete-bundle read; caller must separately authorize #38. */
  pending(companyId: string): Promise<PendingApplication | null>;
}
