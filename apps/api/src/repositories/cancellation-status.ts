export interface CancellationStatus {
  readonly requestId: string;
  readonly orderId: string;
  readonly status: "PENDING" | "APPROVED" | "REJECTED";
}
/** Private read port; never returns reason, actor, ERP reference or payload. */
export interface CancellationStatusRepository {
  latest(
    companyId: string,
    orderId: string,
  ): Promise<{
    createdByUserId: string;
    orderStatus: string;
    cancellation: CancellationStatus | null;
  } | null>;
}
