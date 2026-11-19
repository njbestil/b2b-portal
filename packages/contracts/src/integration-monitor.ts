export interface IntegrationTransactionSummary {
  readonly id: string;
  readonly companyId: string;
  readonly orderId: string;
  readonly operation: "ORDER_SUBMISSION" | "OTHER";
  readonly status:
    "NOT_SENT" | "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "RETRYING";
  readonly retryable: boolean;
  readonly retryCount: number;
  readonly nextRetryAt: string | null;
  readonly errorCode:
    | "OUTCOME_UNKNOWN"
    | "ERP_TEMPORARY_FAILURE"
    | "ERP_UNAVAILABLE"
    | "ERP_TIMEOUT"
    | "ERP_VALIDATION_FAILED"
    | "CREDIT_HOLD"
    | "INSUFFICIENT_STOCK"
    | "INVALID_ITEM"
    | "UNRECOGNIZED"
    | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface IntegrationMonitorListResult {
  readonly items: readonly IntegrationTransactionSummary[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}
export interface IntegrationMonitorDetailResult {
  readonly transaction: IntegrationTransactionSummary;
}
