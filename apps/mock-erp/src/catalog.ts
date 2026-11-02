import { createMasterData } from "./master-data.js";
import { OrderError } from "./orders.js";

/** Bounded synthetic source lookup; never a portal authorization/price resolver. */
export function lookupCatalog(query: Record<string, unknown>) {
  const allowed = [
    "customerId",
    "name",
    "sku",
    "category",
    "brand",
    "availability",
    "offset",
    "limit",
  ];
  const bad = () => {
    throw new OrderError(
      400,
      "INVALID_CATALOG_QUERY",
      "Invalid Mock catalog query.",
    );
  };
  for (const [key, value] of Object.entries(query)) {
    if (
      !allowed.includes(key) ||
      typeof value !== "string" ||
      value.length > 128 ||
      !value.trim()
    )
      bad();
  }
  const seed = createMasterData();
  const customerId = query.customerId;
  if (
    typeof customerId !== "string" ||
    !seed.customers.some((row) => row.customerId === customerId)
  )
    bad();
  const page = (key: string, fallback: number, max: number) => {
    const value = query[key];
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^(0|[1-9]\d{0,5})$/.test(value))
      return bad();
    const number = Number(value);
    if (number > max || (key === "limit" && number === 0)) return bad();
    return number;
  };
  const offset = page("offset", 0, 100000),
    limit = page("limit", 20, 100);
  if (
    query.availability !== undefined &&
    !["available", "unavailable", "unknown"].includes(
      String(query.availability),
    )
  )
    bad();
  const metadata = [
    ["Demo Pantry", "Demo Staples"],
    ["Demo Dairy", "Demo Farm"],
    ["Demo Produce", "Demo Farm"],
    ["Demo Bakery", "Demo Oven"],
    ["Demo Pantry", "Demo Oven"],
  ];
  const products = seed.products.map((product, index) => ({
    ...product,
    category: metadata[index]![0]!,
    brand: metadata[index]![1]!,
  }));
  // An additive catalog-only fixture: absence of inventory/prices is intentional.
  products.push({
    productId: "DEMO-CATALOG-UNKNOWN",
    sku: "DEMO-UNKNOWN-CASE",
    name: "Demo Unknown Stock",
    sellingUom: "Case",
    minimumOrderQuantity: "0.125",
    packSize: null,
    active: true,
    category: "Demo Pantry",
    brand: "Demo Staples",
  });
  const rows = products
    .map((product) => {
      const availableQuantity =
        seed.inventory.find((row) => row.productId === product.productId)
          ?.availableQuantity ?? null;
      const availability =
        availableQuantity === null
          ? "unknown"
          : /[1-9]/.test(availableQuantity)
            ? "available"
            : "unavailable";
      return {
        ...product,
        availableQuantity,
        availability,
        eligibility:
          product.productId === "DEMO-CATALOG-UNKNOWN"
            ? { customerId, productId: product.productId, eligible: true }
            : (seed.eligibility.find(
                (row) =>
                  row.customerId === customerId &&
                  row.productId === product.productId,
              ) ?? null),
        prices: seed.pricing.filter(
          (row) =>
            row.productId === product.productId &&
            (row.customerId === null || row.customerId === customerId),
        ),
      };
    })
    .filter(
      (row) =>
        (["name", "sku", "category", "brand"] as const).every(
          (key) =>
            query[key] === undefined ||
            row[key].toLowerCase().includes(String(query[key]).toLowerCase()),
        ) &&
        (query.availability === undefined ||
          row.availability === query.availability),
    )
    .sort((a, b) =>
      a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
    );
  return {
    source: "synthetic-mock-erp",
    customerId,
    items: rows.slice(offset, offset + limit),
    total: rows.length,
    offset,
    limit,
  };
}
