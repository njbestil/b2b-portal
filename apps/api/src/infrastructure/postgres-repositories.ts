import type { Pool, QueryResultRow } from "pg";
import type { RepositoryPorts } from "../repositories/index.js";
import type { CompanyProfile } from "../repositories/companies.js";
import type { CustomerUserProfile } from "../repositories/users.js";
import type { CatalogProduct } from "../repositories/catalog.js";
import type { OrderSummary } from "../repositories/orders.js";
import type {
  CompanyScope,
  Page,
  PageRequest,
} from "../repositories/common.js";
import { checkedScope, checkedPage } from "../services/query-input.js";

export class PostgresStorageError extends Error {
  constructor() {
    super("PostgreSQL storage operation failed.");
    this.name = "PostgresStorageError";
  }
}

const companySql = `SELECT id, legal_name AS "legalName", trade_name AS "tradeName",
  status, erp_customer_reference AS "erpCustomerReference" FROM companies WHERE id=$1`;
const userSql = `SELECT id, company_id AS "companyId", display_name AS "displayName", role, status
  FROM users WHERE company_id=$1 AND role IN ('CUSTOMER_ADMIN','CUSTOMER_USER')`;
const orderSql = `SELECT id, company_id AS "companyId", order_number AS "orderNumber",
  created_by_user_id AS "createdByUserId", created_at AS "createdAt",
  order_status AS status, integration_status AS "integrationStatus" FROM orders WHERE company_id=$1`;
const catalogSql = `SELECT p.id, p.sku, p.name, p.selling_uom AS "sellingUom",
  p.minimum_order_quantity::text AS "minimumOrderQuantity",
  CASE WHEN cp.id IS NOT NULL THEN cp.amount
    WHEN (p.price_valid_from IS NULL OR p.price_valid_from <= $2::timestamptz)
      AND (p.price_valid_to IS NULL OR p.price_valid_to > $2::timestamptz)
    THEN p.default_price ELSE NULL END::text AS "priceAmount",
  CASE WHEN cp.id IS NOT NULL THEN cp.currency
    WHEN (p.price_valid_from IS NULL OR p.price_valid_from <= $2::timestamptz)
      AND (p.price_valid_to IS NULL OR p.price_valid_to > $2::timestamptz)
    THEN p.currency ELSE NULL END AS "priceCurrency"
  FROM products p JOIN customer_product_access a ON a.product_id=p.id AND a.company_id=$1 AND a.eligible
  LEFT JOIN customer_product_prices cp ON cp.product_id=p.id AND cp.company_id=$1
    AND (cp.valid_from IS NULL OR cp.valid_from <= $2::timestamptz)
    AND (cp.valid_to IS NULL OR cp.valid_to > $2::timestamptz)
  WHERE p.active`;

/** Compile the current read projections without fetching commercial/user data. */
export const postgresReadinessSql = `SELECT c.id, c.legal_name, c.trade_name, c.status, c.erp_customer_reference,
  u.id, u.company_id, u.display_name, u.role, u.status,
  p.id, p.sku, p.name, p.selling_uom, p.minimum_order_quantity, p.active,
  p.default_price, p.currency, p.price_valid_from, p.price_valid_to,
  a.company_id, a.product_id, a.eligible,
  cp.id, cp.company_id, cp.product_id, cp.amount, cp.currency, cp.valid_from, cp.valid_to,
  o.id, o.company_id, o.order_number, o.created_by_user_id, o.created_at, o.order_status, o.integration_status
  FROM companies c, users u, products p, customer_product_access a, customer_product_prices cp, orders o LIMIT 0`;

type RawCatalog = Omit<CatalogProduct, "price"> & {
  priceAmount: string | null;
  priceCurrency: string | null;
};
const catalogProduct = (row: RawCatalog): CatalogProduct => ({
  id: row.id,
  sku: row.sku,
  name: row.name,
  sellingUom: row.sellingUom,
  minimumOrderQuantity: row.minimumOrderQuantity,
  price:
    row.priceAmount === null || row.priceCurrency === null
      ? null
      : { amount: row.priceAmount, currency: row.priceCurrency },
});
type RawOrder = Omit<OrderSummary, "createdAt"> & { createdAt: Date };
const orderSummary = (row: RawOrder): OrderSummary => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});

export function createPostgresRepositories(
  pool: Pick<Pool, "query">,
  now: () => Date = () => new Date(),
): RepositoryPorts {
  const companyId = (scope: CompanyScope) =>
    checkedScope(scope).companyId.toLowerCase();
  const at = () => now().toISOString();
  const query = async <T extends QueryResultRow>(
    sql: string,
    values: unknown[],
  ): Promise<T[]> => {
    try {
      return (await pool.query<T>(sql, values)).rows;
    } catch {
      throw new PostgresStorageError();
    }
  };
  // One statement/snapshot also returns the total for an empty/beyond-end page.
  const list = async <T extends { id: string }>(
    sql: string,
    values: unknown[],
    page: PageRequest,
    sort: string,
  ): Promise<Page<T>> => {
    const request = checkedPage(page);
    const rows = await query<T & { __total: string }>(
      `WITH matching AS MATERIALIZED (${sql})
      SELECT n.total AS "__total", p.* FROM (SELECT count(*)::text AS total FROM matching) n
      LEFT JOIN LATERAL (SELECT * FROM matching ORDER BY ${sort}
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}) p ON true`,
      [...values, request.limit, request.offset],
    );
    const total = Number(rows[0]?.__total);
    if (!Number.isSafeInteger(total) || total < 0)
      throw new PostgresStorageError();
    return {
      total,
      items: rows
        .filter((row) => row.id !== null)
        .map(({ __total: _total, ...item }) => item as unknown as T),
    };
  };
  return {
    companies: {
      async findById(scope) {
        return (
          (await query<CompanyProfile>(companySql, [companyId(scope)]))[0] ??
          null
        );
      },
    },
    users: {
      async findCustomerById(scope, id) {
        return (
          (
            await query<CustomerUserProfile>(userSql + " AND id=$2", [
              companyId(scope),
              id.toLowerCase(),
            ])
          )[0] ?? null
        );
      },
      async listCustomers(scope, page) {
        return list<CustomerUserProfile>(
          userSql,
          [companyId(scope)],
          page,
          "id ASC",
        );
      },
    },
    catalog: {
      async findEligibleById(scope, id) {
        const row = (
          await query<RawCatalog>(catalogSql + " AND p.id=$3", [
            companyId(scope),
            at(),
            id.toLowerCase(),
          ])
        )[0];
        return row ? catalogProduct(row) : null;
      },
      async listEligible(scope, page) {
        const result = await list<RawCatalog>(
          catalogSql,
          [companyId(scope), at()],
          page,
          "id ASC",
        );
        return { total: result.total, items: result.items.map(catalogProduct) };
      },
    },
    orders: {
      async findById(scope, id) {
        const row = (
          await query<RawOrder>(orderSql + " AND id=$2", [
            companyId(scope),
            id.toLowerCase(),
          ])
        )[0];
        return row ? orderSummary(row) : null;
      },
      async list(scope, page) {
        const result = await list<RawOrder>(
          orderSql,
          [companyId(scope)],
          page,
          '"createdAt" DESC, id ASC',
        );
        return { total: result.total, items: result.items.map(orderSummary) };
      },
    },
  };
}
