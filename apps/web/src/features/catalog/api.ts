/** UI projection from CatalogProduct plus nullable metadata proposed to #47/#48. */
export interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  sellingUom: string;
  minimumOrderQuantity: string;
  price: { amount: string; currency: string } | null;
  category: string | null;
  brand: string | null;
  availableQuantity: string | null;
}
export interface CatalogQuery {
  search: string;
  category: string;
  brand: string;
  offset: number;
  limit: number;
}
export interface CatalogPage {
  items: CatalogProduct[];
  total: number;
}
/** Producer owns company eligibility, price resolution, matching, counts and paging. */
export interface CatalogAdapter {
  list(query: CatalogQuery, signal: AbortSignal): Promise<unknown>;
  detail(id: string, signal: AbortSignal): Promise<unknown>;
}
export class CatalogError extends Error {
  readonly code:
    "invalid" | "session" | "forbidden" | "not-found" | "unavailable";
  constructor(code: CatalogError["code"]) {
    super("Catalog could not be loaded.");
    this.code = code;
  }
}
export const defaultQuery: CatalogQuery = {
  search: "",
  category: "",
  brand: "",
  offset: 0,
  limit: 20,
};
const textKeys = ["search", "category", "brand"] as const;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const isProductId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(v);
const decimal = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 100 &&
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v);
const unsafeText = (value: string) =>
  Array.from(value).some((c) => {
    const point = c.codePointAt(0)!;
    return point < 32 || point === 127 || (point >= 0xd800 && point <= 0xdfff);
  });
const text = (v: unknown, limit: number): v is string =>
  typeof v === "string" && !!v.trim() && v.length <= limit && !unsafeText(v);
function product(value: unknown): CatalogProduct {
  if (
    !record(value) ||
    !isProductId(value.id) ||
    !text(value.sku, 100) ||
    !text(value.name, 200) ||
    !text(value.sellingUom, 40) ||
    !decimal(value.minimumOrderQuantity) ||
    !/[1-9]/.test(value.minimumOrderQuantity)
  )
    throw new CatalogError("unavailable");
  let price: CatalogProduct["price"] = null;
  if (value.price !== null) {
    if (
      !record(value.price) ||
      !decimal(value.price.amount) ||
      typeof value.price.currency !== "string" ||
      !/^[A-Z]{3}$/.test(value.price.currency)
    )
      throw new CatalogError("unavailable");
    price = { amount: value.price.amount, currency: value.price.currency };
  }
  for (const key of ["category", "brand"] as const)
    if (value[key] != null && !text(value[key], 100))
      throw new CatalogError("unavailable");
  if (value.availableQuantity != null && !decimal(value.availableQuantity))
    throw new CatalogError("unavailable");
  return {
    id: value.id,
    sku: value.sku,
    name: value.name,
    sellingUom: value.sellingUom,
    minimumOrderQuantity: value.minimumOrderQuantity,
    price,
    category: (value.category as string | null | undefined) ?? null,
    brand: (value.brand as string | null | undefined) ?? null,
    availableQuantity:
      (value.availableQuantity as string | null | undefined) ?? null,
  };
}
/** Local query limits are UI bounds; final HTTP matching remains producer-owned. */
export function parseQuery(params: URLSearchParams): CatalogQuery {
  const allowed = new Set(["search", "category", "brand", "offset", "limit"]);
  for (const key of params.keys())
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      throw new CatalogError("invalid");
  const query = { ...defaultQuery };
  for (const key of textKeys) {
    const value = (params.get(key) ?? "").trim();
    if (value.length > (key === "search" ? 200 : 100) || unsafeText(value))
      throw new CatalogError("invalid");
    query[key] = value;
  }
  for (const key of ["offset", "limit"] as const) {
    const raw = params.get(key);
    if (raw !== null) {
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
        throw new CatalogError("invalid");
      query[key] = Number(raw);
    }
  }
  if (query.limit < 1 || query.limit > 100) throw new CatalogError("invalid");
  return query;
}
export function queryParams(query: CatalogQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of textKeys) if (query[key]) params.set(key, query[key]);
  if (query.offset) params.set("offset", String(query.offset));
  if (query.limit !== 20) params.set("limit", String(query.limit));
  return params;
}
export function filteredQuery(
  query: CatalogQuery,
  values: Pick<CatalogQuery, "search" | "category" | "brand">,
): CatalogQuery {
  return parseQuery(queryParams({ ...query, ...values, offset: 0 }));
}
export const unavailableCatalog: CatalogAdapter = {
  async list() {
    throw new CatalogError("unavailable");
  },
  async detail() {
    throw new CatalogError("unavailable");
  },
};
export class CatalogClient {
  #adapter: CatalogAdapter;
  constructor(adapter: CatalogAdapter = unavailableCatalog) {
    this.#adapter = adapter;
  }
  async list(query: CatalogQuery, signal: AbortSignal): Promise<CatalogPage> {
    const bounded = parseQuery(queryParams(query));
    try {
      const result = await this.#adapter.list(bounded, signal);
      if (
        !record(result) ||
        !Array.isArray(result.items) ||
        !Number.isSafeInteger(result.total) ||
        (result.total as number) < 0 ||
        result.items.length > bounded.limit
      )
        throw new CatalogError("unavailable");
      const items = result.items.map(product),
        ids = new Set(items.map((p) => p.id.toLowerCase()));
      if (
        ids.size !== items.length ||
        items.length > (result.total as number) ||
        (items.length &&
          bounded.offset + items.length > (result.total as number))
      )
        throw new CatalogError("unavailable");
      return { items, total: result.total as number };
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError("unavailable");
    }
  }
  async detail(id: string, signal: AbortSignal): Promise<CatalogProduct> {
    if (!isProductId(id)) throw new CatalogError("not-found");
    try {
      const item = product(await this.#adapter.detail(id, signal));
      if (item.id.toLowerCase() !== id.toLowerCase())
        throw new CatalogError("unavailable");
      return item;
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError("unavailable");
    }
  }
}
/** Bind only confirmed routes; this factory is not enabled in production by default. */
export function createHttpCatalogAdapter(
  read: (path: string, signal?: AbortSignal) => Promise<Response>,
  routes: { list: string; detail: (id: string) => string },
): CatalogAdapter {
  async function data(path: string, signal: AbortSignal) {
    try {
      const response = await read(path, signal);
      if (response.status !== 200)
        throw new CatalogError(
          response.status === 401
            ? "session"
            : response.status === 403
              ? "forbidden"
              : response.status === 404
                ? "not-found"
                : response.status === 400
                  ? "invalid"
                  : "unavailable",
        );
      if (
        !/^application\/json(?:;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw new CatalogError("unavailable");
      const body: unknown = await response.json();
      if (
        !record(body) ||
        body.success !== true ||
        !isProductId(body.requestId) ||
        !record(body.data)
      )
        throw new CatalogError("unavailable");
      return body.data;
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError("unavailable");
    }
  }
  return {
    async list(query, signal) {
      return data(`${routes.list}?${queryParams(query)}`, signal);
    },
    async detail(id, signal) {
      return (await data(routes.detail(encodeURIComponent(id)), signal))
        .product;
    },
  };
}

/** Customer company is derived by the API from the authenticated session. */
export function customerCatalogAdapter(
  read: (path: string, signal?: AbortSignal) => Promise<Response>,
): CatalogAdapter {
  return createHttpCatalogAdapter(read, {
    list: "/api/v1/catalog/products",
    detail: (id) => `/api/v1/catalog/products/${id}`,
  });
}
