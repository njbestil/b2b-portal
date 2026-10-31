import {
  JsonStorageError,
  type JsonCollection,
  type JsonCollections,
  type JsonPrice,
} from "./models.js";
import { normalizedEmail } from "../../services/login.js";

export const collectionFiles = Object.freeze({
  companies: "companies.json",
  users: "users.json",
  products: "products.json",
  customer_product_access: "customer_product_access.json",
  customer_product_prices: "customer_product_prices.json",
  orders: "orders.json",
});
export function checkedCollection(value: string): JsonCollection {
  if (typeof value !== "string" || !Object.hasOwn(collectionFiles, value))
    throw new JsonStorageError("invalid_collection");
  return value as JsonCollection;
}
const invalid = (): never => {
  throw new JsonStorageError("invalid_data");
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : invalid();
}
function id(value: unknown): string {
  const result = text(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    result,
  )
    ? result.toLowerCase()
    : invalid();
}
function bool(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid();
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  return choices.includes(value as T) ? (value as T) : invalid();
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result))
    return invalid();
  const date = new Date(result);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 19) !== result.slice(0, 19)
  )
    return invalid();
  return date.toISOString();
}
function decimal(value: unknown, positive = false): string {
  const result = text(value);
  if (
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(result) ||
    (positive && !/[1-9]/.test(result))
  )
    return invalid();
  return result;
}
function price(value: unknown): JsonPrice {
  const row = object(value);
  const currency = text(row.currency);
  if (!/^[A-Z]{3}$/.test(currency)) return invalid();
  const validFrom = row.validFrom === null ? null : timestamp(row.validFrom);
  const validTo = row.validTo === null ? null : timestamp(row.validTo);
  if (validFrom && validTo && validFrom >= validTo) return invalid();
  return { amount: decimal(row.amount), currency, validFrom, validTo };
}
const statuses = [
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "REJECTED",
  "DEACTIVATED",
] as const;
const parsers: {
  [K in JsonCollection]: (value: unknown) => JsonCollections[K];
} = {
  companies(value) {
    const row = object(value);
    return {
      id: id(row.id),
      legalName: text(row.legalName),
      tradeName: text(row.tradeName),
      status: choice(row.status, statuses),
      erpCustomerReference:
        row.erpCustomerReference === null
          ? null
          : text(row.erpCustomerReference),
    };
  },
  users(value) {
    const row = object(value);
    const email =
      row.email === undefined ? undefined : normalizedEmail(row.email);
    if (row.email !== undefined && !email) return invalid();
    const role = choice(row.role, [
      "CUSTOMER_ADMIN",
      "CUSTOMER_USER",
      "INTERNAL_ADMIN",
      "SALES_STAFF",
    ] as const);
    const customer = role === "CUSTOMER_ADMIN" || role === "CUSTOMER_USER";
    if (!customer && row.companyId !== null) return invalid();
    return {
      ...(email === undefined
        ? {}
        : {
            email,
            passwordHash: text(row.passwordHash),
            mustChangePassword: bool(row.mustChangePassword),
          }),
      id: id(row.id),
      companyId: customer ? id(row.companyId) : null,
      displayName: text(row.displayName),
      role,
      status: choice(row.status, statuses),
    };
  },
  products(value) {
    const row = object(value);
    return {
      ...(row.erpProductReference === undefined
        ? {}
        : { erpProductReference: text(row.erpProductReference) }),
      id: id(row.id),
      sku: text(row.sku),
      name: text(row.name),
      sellingUom: text(row.sellingUom),
      minimumOrderQuantity: decimal(row.minimumOrderQuantity, true),
      active: bool(row.active),
      defaultPrice: row.defaultPrice === null ? null : price(row.defaultPrice),
    };
  },
  customer_product_access(value) {
    const row = object(value);
    return {
      companyId: id(row.companyId),
      productId: id(row.productId),
      eligible: bool(row.eligible),
    };
  },
  customer_product_prices(value) {
    const row = object(value);
    return {
      companyId: id(row.companyId),
      productId: id(row.productId),
      price: price(row.price),
    };
  },
  orders(value) {
    const row = object(value);
    return {
      id: id(row.id),
      companyId: id(row.companyId),
      orderNumber: row.orderNumber === null ? null : text(row.orderNumber),
      createdByUserId: id(row.createdByUserId),
      createdAt: timestamp(row.createdAt),
      status: choice(row.status, [
        "DRAFT",
        "PENDING_CUSTOMER_CONFIRMATION",
        "SUBMITTED",
        "CONFIRMED",
        "FULFILLING",
        "DELIVERED",
        "CANCELLED",
        "REJECTED",
      ] as const),
      integrationStatus: choice(row.integrationStatus, [
        "NOT_SENT",
        "PENDING",
        "PROCESSING",
        "SUCCESS",
        "FAILED",
        "RETRYING",
      ] as const),
    };
  },
};

/** Validate and project known fields into fresh objects, never return raw file data. */
export function parseCollection<K extends JsonCollection>(
  collection: K,
  value: unknown,
): JsonCollections[K][] {
  if (!Array.isArray(value)) return invalid();
  const seen = new Set<string>();
  const emails = new Set<string>();
  // Array.from visits sparse slots too; map would persist holes as invalid nulls.
  return Array.from(value, (item) => {
    const row = parsers[collection](item);
    const raw = object(row);
    if (collection === "users" && typeof raw.email === "string") {
      if (emails.has(raw.email)) return invalid();
      emails.add(raw.email);
    }
    const key =
      collection === "customer_product_access" ||
      collection === "customer_product_prices"
        ? JSON.stringify([raw.companyId, raw.productId])
        : String(raw.id);
    if (seen.has(key)) return invalid();
    seen.add(key);
    return row;
  });
}
