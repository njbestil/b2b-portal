import type { OrderSnapshot } from "./order-snapshots.js";
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

export interface HistoryFilters {
  readonly search?: string;
  readonly status?: OrderStatus;
  readonly from?: string;
  readonly to?: string;
}
export interface OrderHistoryRecord extends OrderSummary {
  /** Provider-verified retained customer approval for a Sales-created order. */
  readonly confirmedByUserId?: string | null;
  readonly snapshot: OrderSnapshot | null;
}
export interface OrderRepository {
  findHistory(
    scope: CompanyScope,
    orderId: EntityId,
  ): Promise<OrderHistoryRecord | null>;
  listHistory(
    scope: CompanyScope,
    page: PageRequest,
    filters: HistoryFilters,
  ): Promise<Page<OrderSummary>>;
  findById(
    scope: CompanyScope,
    orderId: EntityId,
  ): Promise<OrderSummary | null>;
  /** Company orders, ordered by createdAt descending, then id ascending. */
  list(scope: CompanyScope, page: PageRequest): Promise<Page<OrderSummary>>;
}
