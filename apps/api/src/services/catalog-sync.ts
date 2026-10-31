import type {
  CachePrice,
  CatalogCache,
  CatalogCacheRepository,
  CatalogContext,
  CatalogSnapshot,
  CatalogSource,
} from "../repositories/catalog-sync.js";
export class CatalogSyncError extends Error {
  constructor() {
    super("Catalog synchronization failed.");
    this.name = "CatalogSyncError";
  }
}
const fail = (): never => {
  throw new CatalogSyncError();
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const text = (v: unknown): string =>
  typeof v === "string" && v.length <= 256 && v.trim() && v === v.trim()
    ? v
    : fail();
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail());
const decimal = (v: unknown, positive = false): string =>
  typeof v === "string" &&
  /^(?:0|[1-9]\d{0,23})(?:\.\d{1,18})?$/.test(v) &&
  (!positive || /[1-9]/.test(v))
    ? v
    : fail();
const timestamp = (v: unknown): string | null =>
  v === null
    ? null
    : typeof v === "string" &&
        Number.isFinite(Date.parse(v)) &&
        new Date(v).toISOString() === v
      ? v
      : fail();
function price(v: unknown): CachePrice {
  const p = object(v),
    currency = text(p.currency),
    validFrom = timestamp(p.validFrom),
    validTo = timestamp(p.validTo);
  if (
    !/^[A-Z]{3}$/.test(currency) ||
    (validFrom && validTo && validFrom >= validTo)
  )
    return fail();
  return { amount: decimal(p.amount), currency, validFrom, validTo };
}
function rows<T>(
  v: unknown,
  parse: (r: Record<string, unknown>) => T,
  key: (r: T) => string,
): T[] {
  if (!Array.isArray(v) || v.length > 10000) return fail();
  const seen = new Set<string>();
  return Array.from(v, (item) => {
    const row = parse(object(item)),
      id = key(row);
    if (seen.has(id)) return fail();
    seen.add(id);
    return row;
  });
}
export function checkedCatalog(value: unknown): CatalogSnapshot {
  const input = object(value);
  const customers = rows(
    input.customers,
    (r) => ({ reference: text(r.reference), active: bool(r.active) }),
    (r) => r.reference,
  );
  const products = rows(
    input.products,
    (r) => ({
      reference: text(r.reference),
      sku: text(r.sku),
      name: text(r.name),
      sellingUom: text(r.sellingUom),
      minimumOrderQuantity: decimal(r.minimumOrderQuantity, true),
      active: bool(r.active),
    }),
    (r) => r.reference,
  );
  if (
    !products.length ||
    new Set(products.map((p) => p.sku)).size !== products.length
  )
    return fail();
  const prices = rows(
    input.prices,
    (r) => ({
      productReference: text(r.productReference),
      customerReference:
        r.customerReference === null ? null : text(r.customerReference),
      price: price(r.price),
    }),
    (r) => JSON.stringify([r.productReference, r.customerReference]),
  );
  const access = rows(
    input.access,
    (r) => ({
      customerReference: text(r.customerReference),
      productReference: text(r.productReference),
      eligible: bool(r.eligible),
    }),
    (r) => JSON.stringify([r.customerReference, r.productReference]),
  );
  const knownProduct = new Set(products.map((p) => p.reference)),
    knownCustomer = new Set(customers.map((c) => c.reference));
  for (const p of prices)
    if (
      !knownProduct.has(p.productReference) ||
      (p.customerReference !== null && !knownCustomer.has(p.customerReference))
    )
      return fail();
  for (const a of access)
    if (
      !knownProduct.has(a.productReference) ||
      !knownCustomer.has(a.customerReference)
    )
      return fail();
  return { customers, products, prices, access };
}
function buildCache(
  source: CatalogSnapshot,
  context: CatalogContext,
  newId: () => string,
): CatalogCache {
  const companies = new Map<string, string>();
  for (const c of context.companies)
    if (c.erpCustomerReference !== null) {
      if (companies.has(c.erpCustomerReference)) return fail();
      companies.set(c.erpCustomerReference, c.id);
    }
  const existing = new Map<string, string>();
  for (const p of context.products)
    if (p.erpProductReference) {
      if (existing.has(p.erpProductReference)) return fail();
      existing.set(p.erpProductReference, p.id);
    }
  const prices = new Map(
    source.prices
      .filter((p) => p.customerReference === null)
      .map((p) => [p.productReference, p.price]),
  );
  const current = source.products.map((p) => ({
    id:
      existing.get(p.reference) ??
      context.products.find(
        (old) => !old.erpProductReference && old.sku === p.sku,
      )?.id ??
      newId(),
    erpProductReference: p.reference,
    sku: p.sku,
    name: p.name,
    sellingUom: p.sellingUom,
    minimumOrderQuantity: p.minimumOrderQuantity,
    active: p.active,
    defaultPrice: prices.get(p.reference) ?? null,
  }));
  const ids = new Map(current.map((p) => [p.erpProductReference, p.id]));
  const products = [
    ...current,
    ...context.products
      .filter((old) => !current.some((p) => p.id === old.id))
      .map((old) => ({ ...old, active: false, defaultPrice: null })),
  ];
  if (
    new Set(products.map((p) => p.id)).size !== products.length ||
    new Set(products.map((p) => p.sku)).size !== products.length
  )
    return fail();
  const activeCustomers = new Set(
    source.customers.filter((c) => c.active).map((c) => c.reference),
  );
  return {
    products,
    customer_product_access: source.access
      .filter((a) => companies.has(a.customerReference))
      .map((a) => ({
        companyId: companies.get(a.customerReference)!,
        productId: ids.get(a.productReference)!,
        eligible: a.eligible && activeCustomers.has(a.customerReference),
      })),
    customer_product_prices: source.prices
      .filter(
        (p) =>
          p.customerReference !== null && companies.has(p.customerReference),
      )
      .map((p) => ({
        companyId: companies.get(p.customerReference!)!,
        productId: ids.get(p.productReference)!,
        price: p.price,
      })),
  };
}
export function createCatalogSync(
  source: CatalogSource,
  cache: CatalogCacheRepository,
  newId: () => string,
) {
  return {
    async synchronize(signal: AbortSignal) {
      try {
        if (signal.aborted) return fail();
        const snapshot = checkedCatalog(await source.readSnapshot(signal));
        if (signal.aborted) return fail();
        return await cache.refresh((context) => {
          if (signal.aborted) return fail();
          return buildCache(snapshot, context, newId);
        });
      } catch {
        throw new CatalogSyncError();
      }
    },
  };
}
