export interface CachePrice {
  amount: string;
  currency: string;
  validFrom: string | null;
  validTo: string | null;
}
export interface CachedProduct {
  id: string;
  erpProductReference?: string;
  sku: string;
  name: string;
  sellingUom: string;
  minimumOrderQuantity: string;
  active: boolean;
  defaultPrice: CachePrice | null;
}
export interface CatalogSnapshot {
  customers: { reference: string; active: boolean }[];
  products: {
    reference: string;
    sku: string;
    name: string;
    sellingUom: string;
    minimumOrderQuantity: string;
    active: boolean;
  }[];
  prices: {
    productReference: string;
    customerReference: string | null;
    price: CachePrice;
  }[];
  access: {
    customerReference: string;
    productReference: string;
    eligible: boolean;
  }[];
}
export interface CatalogContext {
  companies: { id: string; erpCustomerReference: string | null }[];
  products: CachedProduct[];
}
export interface CatalogCache {
  products: CachedProduct[];
  customer_product_access: {
    companyId: string;
    productId: string;
    eligible: boolean;
  }[];
  customer_product_prices: {
    companyId: string;
    productId: string;
    price: CachePrice;
  }[];
}
export interface CatalogSource {
  readSnapshot(signal: AbortSignal): Promise<CatalogSnapshot>;
}
/** Hold provider publication/transaction ownership while resolving existing IDs. */
export interface CatalogCacheRepository {
  refresh(
    build: (context: CatalogContext) => CatalogCache,
  ): Promise<{ products: number; access: number; prices: number }>;
}
