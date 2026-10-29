/** Logical UUIDs and UTC ISO-8601 timestamps, never provider-specific values. */
export type EntityId = string;
export type Timestamp = string;

/** Exact base-10 value (including fractional quantities); never a JS float. */
export type Decimal = string;

export type AccountStatus =
  "PENDING" | "ACTIVE" | "SUSPENDED" | "REJECTED" | "DEACTIVATED";

/** Obtained from backend authorization, not a customer-supplied company ID. */
export interface CompanyScope {
  readonly companyId: EntityId;
}

export interface PageRequest {
  readonly offset: number;
  readonly limit: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Total matching records before pagination, within the same company. */
  readonly total: number;
}
