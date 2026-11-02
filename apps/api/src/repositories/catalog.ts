import type {
  CompanyScope,
  Decimal,
  EntityId,
  Page,
  PageRequest,
} from "./common.js";

/** ERP-owned reference data, already filtered for this company's eligibility. */
export interface CatalogProduct {
  readonly metadata?: CatalogMetadata;
  readonly id: EntityId;
  readonly sku: string;
  readonly name: string;
  readonly sellingUom: string;
  readonly minimumOrderQuantity: Decimal;
  /** Resolved customer/default price; null means no valid browsing price. */
  readonly price: {
    readonly amount: Decimal;
    readonly currency: string;
  } | null;
}

export interface CatalogMetadata {
  readonly category: string | null;
  readonly brand: string | null;
  readonly availableQuantity: string | null;
}

export interface CatalogFilters {
  readonly name?: string;
  readonly sku?: string;
  readonly category?: string;
  readonly brand?: string;
  readonly search?: string;
  readonly availability?: "available" | "unavailable" | "unknown";
}

export interface CatalogRepository {
  /** Ineligible, inactive and missing products all return null. */
  findEligibleById(
    scope: CompanyScope,
    productId: EntityId,
  ): Promise<CatalogProduct | null>;
  /** Eligible active products, ordered by id ascending. Not submit validation. */
  listEligible(
    scope: CompanyScope,
    page: PageRequest,
    filters?: CatalogFilters,
  ): Promise<Page<CatalogProduct>>;
}
