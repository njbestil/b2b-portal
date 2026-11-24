export const integrationStatuses = [
  "NOT_SENT",
  "PENDING",
  "PROCESSING",
  "SUCCESS",
  "FAILED",
  "RETRYING",
] as const;
export type IntegrationStatus = (typeof integrationStatuses)[number];
export const integrationErrorCodes = [
  "OUTCOME_UNKNOWN",
  "ERP_TEMPORARY_FAILURE",
  "ERP_UNAVAILABLE",
  "ERP_TIMEOUT",
  "ERP_VALIDATION_FAILED",
  "CREDIT_HOLD",
  "INSUFFICIENT_STOCK",
  "INVALID_ITEM",
] as const;
export type IntegrationErrorCode =
  (typeof integrationErrorCodes)[number] | "UNRECOGNIZED";
export interface IntegrationMonitorActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessExpiresAt: string;
}
export interface IntegrationMonitorQuery {
  readonly offset: number;
  readonly limit: number;
  readonly status?: IntegrationStatus;
  readonly companyId?: string;
  readonly orderId?: string;
  readonly q?: string;
}
export interface IntegrationTransactionSummary {
  readonly id: string;
  readonly companyId: string;
  readonly orderId: string;
  readonly operation: "ORDER_SUBMISSION" | "OTHER";
  readonly status: IntegrationStatus;
  readonly retryable: boolean;
  readonly retryCount: number;
  readonly nextRetryAt: string | null;
  readonly errorCode: IntegrationErrorCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
/** Private read-only monitoring port; no dispatch/retry or payload capability. */
export interface IntegrationMonitorRepository {
  list(
    actor: IntegrationMonitorActor,
    query: IntegrationMonitorQuery,
    signal: AbortSignal,
  ): Promise<{ items: IntegrationTransactionSummary[]; total: number }>;
  find(
    actor: IntegrationMonitorActor,
    id: string,
    signal: AbortSignal,
  ): Promise<IntegrationTransactionSummary | null>;
}
