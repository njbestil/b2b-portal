export type AuditRole =
  "INTERNAL_ADMIN" | "SALES_STAFF" | "CUSTOMER_ADMIN" | "CUSTOMER_USER";
export interface AuditMetadata {
  readonly requestId?: string;
  readonly transactionId?: string;
  readonly orderId?: string;
  readonly reasonCode?: string;
  readonly outcome?: "success" | "failure" | "denied";
  readonly changedFields?: readonly string[];
}
/** Trusted backend event context, never an HTTP body or authentication proof. */
export interface AuditInput {
  readonly companyId: string | null;
  readonly actorUserId: string | null;
  readonly actorRole: AuditRole | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly metadata: AuditMetadata;
}
export interface AuditRecord extends AuditInput {
  readonly id: string;
  readonly createdAt: string;
}
/** Append only; no customer/public query or alteration capability. */
export interface AuditRepository {
  append(record: AuditRecord): Promise<AuditRecord>;
}
