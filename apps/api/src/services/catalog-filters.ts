import type {
  CatalogFilters,
  CatalogProduct,
} from "../repositories/catalog.js";
import type { PageRequest } from "../repositories/common.js";
import { checkedPage } from "./query-input.js";

export const catalogTextKeys = [
  "name",
  "sku",
  "category",
  "brand",
  "search",
] as const;
/** ASCII case folding is identical in JavaScript and PostgreSQL, independent of locale. */
export const catalogFold = (value: string) =>
  value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const invalidText = (value: string) =>
  Array.from(value).some((letter) => {
    const code = letter.codePointAt(0)!;
    return (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff)
    );
  });

export function checkedCatalogFilters(input: unknown = {}): CatalogFilters {
  const bad = (): never => {
    throw new TypeError("Invalid catalog filters.");
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![...catalogTextKeys, "availability"].includes(
          key as (typeof catalogTextKeys)[number],
        ),
    )
  )
    return bad();
  const result: Record<string, string> = {};
  for (const key of catalogTextKeys) {
    const text = value[key];
    if (text === undefined) continue;
    if (typeof text !== "string" || text.length > 128 || invalidText(text))
      return bad();
    const normalized = text.trim();
    if (normalized) result[key] = catalogFold(normalized);
  }
  if (value.availability !== undefined && value.availability !== "all") {
    if (
      typeof value.availability !== "string" ||
      !["available", "unavailable", "unknown"].includes(value.availability)
    )
      return bad();
    result.availability = value.availability;
  }
  return result as CatalogFilters;
}

export function checkedCatalogPage(input?: PageRequest): PageRequest {
  const page = checkedPage(input);
  if (page.offset > 100000)
    throw new RangeError("Catalog offset exceeds 100000.");
  return page;
}

export function matchesCatalog(
  row: CatalogProduct,
  filters: CatalogFilters,
): boolean {
  for (const key of ["name", "sku"] as const)
    if (
      filters[key] !== undefined &&
      !catalogFold(row[key]).includes(filters[key])
    )
      return false;
  for (const key of ["category", "brand"] as const)
    if (
      filters[key] !== undefined &&
      (row.metadata?.[key] == null ||
        catalogFold(row.metadata[key]) !== filters[key])
    )
      return false;
  if (
    filters.search !== undefined &&
    ![row.name, row.sku].some((text) =>
      catalogFold(text).includes(filters.search!),
    )
  )
    return false;
  const stock = row.metadata?.availableQuantity;
  const availability =
    stock == null
      ? "unknown"
      : /[1-9]/.test(stock)
        ? "available"
        : "unavailable";
  return (
    filters.availability === undefined || filters.availability === availability
  );
}
