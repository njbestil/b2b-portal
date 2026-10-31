import type { CompanyProfile } from "../../repositories/companies.js";
import type { CatalogProduct } from "../../repositories/catalog.js";
import type { AccountStatus, Timestamp } from "../../repositories/common.js";
import type { OrderSummary } from "../../repositories/orders.js";

/** Initial cache projections, not the complete future business entity schema. */
export interface JsonPrice {
  readonly amount: string;
  readonly currency: string;
  readonly validFrom: Timestamp | null;
  readonly validTo: Timestamp | null;
}
export interface JsonProduct extends Omit<CatalogProduct, "price"> {
  readonly erpProductReference?: string;
  readonly active: boolean;
  readonly defaultPrice: JsonPrice | null;
}
export interface JsonCompany extends CompanyProfile {
  readonly application?: import("../../repositories/applications.js").PendingApplication;
}
export interface JsonUser {
  readonly mobile?: string;
  /** Optional private credential fields; legacy/demo projections stay unprovisioned. */
  readonly email?: string;
  readonly passwordHash?: string;
  readonly mustChangePassword?: boolean;
  readonly id: string;
  readonly companyId: string | null;
  readonly displayName: string;
  readonly role:
    "CUSTOMER_ADMIN" | "CUSTOMER_USER" | "INTERNAL_ADMIN" | "SALES_STAFF";
  readonly status: AccountStatus;
}
export interface JsonProductAccess {
  readonly companyId: string;
  readonly productId: string;
  readonly eligible: boolean;
}
export interface JsonCustomerPrice {
  readonly companyId: string;
  readonly productId: string;
  readonly price: JsonPrice;
}
export interface JsonCollections {
  companies: JsonCompany;
  users: JsonUser;
  products: JsonProduct;
  customer_product_access: JsonProductAccess;
  customer_product_prices: JsonCustomerPrice;
  orders: OrderSummary;
}
export type JsonCollection = keyof JsonCollections;

export class JsonStorageError extends Error {
  constructor(
    readonly code:
      "invalid_collection" | "invalid_data" | "read_failed" | "write_failed",
  ) {
    super(`JSON storage failed: ${code}`);
    this.name = "JsonStorageError";
  }
}
