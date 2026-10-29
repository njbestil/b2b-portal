import type {
  CompanyScope,
  EntityId,
  Page,
  PageRequest,
  Timestamp,
} from "./common.js";

export type OrderStatus =
  | "DRAFT"
  | "PENDING_CUSTOMER_CONFIRMATION"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FULFILLING"
  | "DELIVERED"
  | "CANCELLED"
  | "REJECTED";

export type IntegrationStatus =
  "NOT_SENT" | "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "RETRYING";

/** Summary only: no internal notes, ERP errors or mutable master-data joins. */
export interface OrderSummary {
  readonly id: EntityId;
  readonly companyId: EntityId;
  readonly orderNumber: string | null;
  readonly createdByUserId: EntityId;
  readonly createdAt: Timestamp;
  readonly status: OrderStatus;
  readonly integrationStatus: IntegrationStatus;
}

export interface OrderRepository {
  findById(
    scope: CompanyScope,
    orderId: EntityId,
  ): Promise<OrderSummary | null>;
  /** Company orders, ordered by createdAt descending, then id ascending. */
  list(scope: CompanyScope, page: PageRequest): Promise<Page<OrderSummary>>;
}
