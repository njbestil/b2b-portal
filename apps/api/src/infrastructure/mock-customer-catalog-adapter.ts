import type { ErpEnvironment } from "@b2b-portal/config/server";
import { parseErpEnvironment } from "@b2b-portal/config/server";
import type { CatalogSource } from "../repositories/catalog-sync.js";
import { checkedCatalog, CatalogSyncError } from "../services/catalog-sync.js";
import { createMockCatalogSource } from "./mock-catalog-adapter.js";

const fail = (): never => {
  throw new CatalogSyncError();
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
}
function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) && value.length <= 10000
    ? value.map(object)
    : fail();
}
/** Explicit #144 consumer. Raw customer price inputs stay unresolved until cache reads. */
export function createMockCustomerCatalogSource(
  config: ErpEnvironment,
): CatalogSource {
  const validated = parseErpEnvironment({
    ERP_BASE_URL: config.baseUrl,
    ERP_TIMEOUT_MS: String(config.timeoutMs),
  });
  if (!validated) return fail();
  const legacy = createMockCatalogSource(validated);
  return {
    async readSnapshot(signal) {
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, validated.timeoutMs);
      async function read(url: URL) {
        const response = await fetch(url, {
          redirect: "error",
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        if (
          !response.ok ||
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          !response.body
        ) {
          await response.body?.cancel();
          return fail();
        }
        const reader = response.body.getReader();
        try {
          let size = 0,
            text = "";
          const decoder = new TextDecoder("utf-8", { fatal: true });
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1048576) return fail();
            text += decoder.decode(value, { stream: true });
          }
          return object(JSON.parse(text + decoder.decode()));
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      try {
        const seed = await legacy.readSnapshot(controller.signal);
        if (!seed.customers.length || seed.customers.length > 100)
          return fail();
        const products = new Map<string, unknown>(),
          prices = new Map<string, unknown>(),
          access: unknown[] = [];
        function unique(
          map: Map<string, unknown>,
          key: string,
          value: unknown,
        ) {
          if (
            map.has(key) &&
            JSON.stringify(map.get(key)) !== JSON.stringify(value)
          )
            return fail();
          map.set(key, value);
        }
        let readCount = 0;
        for (const customer of seed.customers) {
          const seen = new Set<string>();
          let total: number | undefined;
          for (let offset = 0; ; offset += 100) {
            if (++readCount > 10000 || controller.signal.aborted) return fail();
            const url = new URL("catalog", validated.baseUrl);
            url.search = new URLSearchParams({
              customerId: customer.reference,
              offset: String(offset),
              limit: "100",
            }).toString();
            const data = await read(url),
              items = array(data.items);
            if (
              data.source !== "synthetic-mock-erp" ||
              data.customerId !== customer.reference ||
              data.offset !== offset ||
              data.limit !== 100 ||
              !Number.isSafeInteger(data.total) ||
              Number(data.total) < 0 ||
              Number(data.total) > 10000 ||
              (total !== undefined && data.total !== total)
            )
              return fail();
            total = Number(data.total);
            if (items.length !== Math.min(100, Math.max(0, total - offset)))
              return fail();
            for (const item of items) {
              if (
                typeof item.productId !== "string" ||
                seen.has(item.productId)
              )
                return fail();
              seen.add(item.productId);
              unique(products, item.productId, {
                reference: item.productId,
                sku: item.sku,
                name: item.name,
                sellingUom: item.sellingUom,
                minimumOrderQuantity: item.minimumOrderQuantity,
                active: item.active,
                metadata: {
                  category: item.category,
                  brand: item.brand,
                  availableQuantity: item.availableQuantity,
                },
              });
              if (item.eligibility !== null) {
                const row = object(item.eligibility);
                if (
                  row.customerId !== customer.reference ||
                  row.productId !== item.productId
                )
                  return fail();
                access.push({
                  customerReference: row.customerId,
                  productReference: row.productId,
                  eligible: row.eligible,
                });
              }
              for (const row of array(item.prices)) {
                if (
                  row.productId !== item.productId ||
                  (row.customerId !== null &&
                    row.customerId !== customer.reference)
                )
                  return fail();
                const key = JSON.stringify([row.productId, row.customerId]);
                unique(prices, key, {
                  productReference: row.productId,
                  customerReference: row.customerId,
                  price: {
                    amount: row.unitPrice,
                    currency: row.currency,
                    validFrom: row.effectiveFrom,
                    validTo: row.effectiveTo,
                  },
                });
              }
            }
            if (offset + items.length >= total) break;
          }
        }
        return checkedCatalog({
          customers: seed.customers,
          products: [...products.values()],
          prices: [...prices.values()],
          access,
        });
      } catch {
        return fail();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
