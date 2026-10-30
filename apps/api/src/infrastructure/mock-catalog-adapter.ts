import type { ErpEnvironment } from "@b2b-portal/config/server";
import { parseErpEnvironment } from "@b2b-portal/config/server";
import type { CatalogSource } from "../repositories/catalog-sync.js";
import { checkedCatalog, CatalogSyncError } from "../services/catalog-sync.js";
const rows = (v: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(v) || v.length > 10000) throw new CatalogSyncError();
  return v.map((r) => {
    if (!r || typeof r !== "object" || Array.isArray(r))
      throw new CatalogSyncError();
    return r;
  });
};
export function createMockCatalogSource(config: ErpEnvironment): CatalogSource {
  const validated = parseErpEnvironment({
    ERP_BASE_URL: config.baseUrl,
    ERP_TIMEOUT_MS: String(config.timeoutMs),
  });
  if (!validated) throw new CatalogSyncError();
  const url = new URL("master-data", validated.baseUrl);
  return {
    async readSnapshot(signal) {
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, validated.timeoutMs);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetch(url, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
        if (
          !response.ok ||
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          !response.body
        ) {
          await response.body?.cancel();
          throw new CatalogSyncError();
        }
        reader = response.body.getReader();
        let size = 0,
          text = "";
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1048576) throw new CatalogSyncError();
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        const payload: unknown = JSON.parse(text);
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          throw new CatalogSyncError();
        const data = payload as Record<string, unknown>;
        return checkedCatalog({
          customers: rows(data.customers).map((r) => ({
            reference: r.customerId,
            active: r.active,
          })),
          products: rows(data.products).map((r) => ({
            reference: r.productId,
            sku: r.sku,
            name: r.name,
            sellingUom: r.sellingUom,
            minimumOrderQuantity: r.minimumOrderQuantity,
            active: r.active,
          })),
          prices: rows(data.pricing).map((r) => ({
            productReference: r.productId,
            customerReference: r.customerId,
            price: {
              amount: r.unitPrice,
              currency: r.currency,
              validFrom: r.effectiveFrom,
              validTo: r.effectiveTo,
            },
          })),
          access: rows(data.eligibility).map((r) => ({
            customerReference: r.customerId,
            productReference: r.productId,
            eligible: r.eligible,
          })),
        });
      } catch {
        throw new CatalogSyncError();
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
