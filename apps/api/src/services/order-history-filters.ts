import type {
  HistoryFilters,
  OrderStatus,
  OrderSummary,
} from "../repositories/orders.js";
import { catalogFold } from "./catalog-filters.js";
export const historyStatuses = [
  "PENDING_CUSTOMER_CONFIRMATION",
  "SUBMITTED",
  "CONFIRMED",
  "FULFILLING",
  "DELIVERED",
  "CANCELLED",
  "REJECTED",
] as const;
export function checkedHistoryFilters(input: unknown): HistoryFilters {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Invalid history filters.");
  const value = input as Record<string, unknown>,
    result: { -readonly [K in keyof HistoryFilters]: HistoryFilters[K] } = {};
  if (
    Object.keys(value).some(
      (k) => !["search", "status", "from", "to"].includes(k),
    )
  )
    throw new TypeError("Invalid history filters.");
  if (value.search !== undefined) {
    if (
      typeof value.search !== "string" ||
      value.search.length > 128 ||
      Array.from(value.search).some((letter) => {
        const code = letter.codePointAt(0)!;
        return (
          code < 32 ||
          (code >= 127 && code <= 159) ||
          (code >= 0xd800 && code <= 0xdfff)
        );
      })
    )
      throw new TypeError("Invalid search.");
    if (value.search.trim()) result.search = catalogFold(value.search.trim());
  }
  if (value.status !== undefined && value.status !== "all") {
    if (
      typeof value.status !== "string" ||
      !(historyStatuses as readonly string[]).includes(value.status)
    )
      throw new TypeError("Invalid status.");
    result.status = value.status as OrderStatus;
  }
  for (const key of ["from", "to"] as const) {
    const date = value[key];
    if (date === undefined || date === "") continue;
    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      date < "0001-01-01" ||
      date > "9999-12-30"
    )
      throw new TypeError("Invalid date.");
    const time = new Date(date + "T00:00:00.000Z");
    if (
      !Number.isFinite(time.getTime()) ||
      time.toISOString().slice(0, 10) !== date
    )
      throw new TypeError("Invalid date.");
    result[key] = date;
  }
  if (result.from && result.to && result.from > result.to)
    throw new TypeError("Invalid date range.");
  return result;
}
export function matchesHistory(
  row: OrderSummary,
  filters: HistoryFilters,
): boolean {
  return (
    row.status !== "DRAFT" &&
    (!filters.status || row.status === filters.status) &&
    (!filters.search ||
      catalogFold(row.orderNumber ?? "").includes(filters.search)) &&
    (!filters.from || row.createdAt.slice(0, 10) >= filters.from) &&
    (!filters.to || row.createdAt.slice(0, 10) <= filters.to)
  );
}
