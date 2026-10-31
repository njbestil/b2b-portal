import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type {
  CatalogCacheRepository,
  CatalogContext,
} from "../repositories/catalog-sync.js";
import { CatalogSyncError } from "../services/catalog-sync.js";
export function createPostgresCatalogCache(pool: Pool): CatalogCacheRepository {
  return {
    async refresh(build) {
      let client: PoolClient | undefined;
      let began = false;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        began = true;
        await client.query("SELECT pg_advisory_xact_lock(1937825,34)");
        await client.query(
          "LOCK TABLE products,customer_product_access,customer_product_prices IN EXCLUSIVE MODE",
        );
        const companies = (
          await client.query(
            'SELECT id,erp_customer_reference AS "erpCustomerReference" FROM companies FOR SHARE',
          )
        ).rows;
        const products = (
          await client.query(
            'SELECT id,erp_product_reference AS "erpProductReference",sku,name,selling_uom AS "sellingUom",minimum_order_quantity::text AS "minimumOrderQuantity",active FROM products',
          )
        ).rows;
        const cache = build({
          companies,
          products: products.map((p) => ({ ...p, defaultPrice: null })),
        } as CatalogContext);
        for (const p of cache.products)
          await client.query(
            `INSERT INTO products(id,erp_product_reference,sku,name,selling_uom,minimum_order_quantity,active,default_price,currency,price_valid_from,price_valid_to,synced_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET erp_product_reference=EXCLUDED.erp_product_reference,sku=EXCLUDED.sku,name=EXCLUDED.name,selling_uom=EXCLUDED.selling_uom,minimum_order_quantity=EXCLUDED.minimum_order_quantity,active=EXCLUDED.active,default_price=EXCLUDED.default_price,currency=EXCLUDED.currency,price_valid_from=EXCLUDED.price_valid_from,price_valid_to=EXCLUDED.price_valid_to,synced_at=EXCLUDED.synced_at`,
            [
              p.id,
              p.erpProductReference,
              p.sku,
              p.name,
              p.sellingUom,
              p.minimumOrderQuantity,
              p.active,
              p.defaultPrice?.amount ?? null,
              p.defaultPrice?.currency ?? null,
              p.defaultPrice?.validFrom ?? null,
              p.defaultPrice?.validTo ?? null,
            ],
          );
        await client.query("DELETE FROM customer_product_access");
        await client.query("DELETE FROM customer_product_prices");
        for (const a of cache.customer_product_access)
          await client.query(
            "INSERT INTO customer_product_access(id,company_id,product_id,eligible,synced_at) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)",
            [randomUUID(), a.companyId, a.productId, a.eligible],
          );
        for (const p of cache.customer_product_prices)
          await client.query(
            "INSERT INTO customer_product_prices(id,company_id,product_id,amount,currency,valid_from,valid_to,synced_at) VALUES($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)",
            [
              randomUUID(),
              p.companyId,
              p.productId,
              p.price.amount,
              p.price.currency,
              p.price.validFrom,
              p.price.validTo,
            ],
          );
        await client.query("COMMIT");
        began = false;
        return {
          products: cache.products.length,
          access: cache.customer_product_access.length,
          prices: cache.customer_product_prices.length,
        };
      } catch {
        if (began) await client?.query("ROLLBACK").catch(() => {});
        throw new CatalogSyncError();
      } finally {
        client?.release();
      }
    },
  };
}
