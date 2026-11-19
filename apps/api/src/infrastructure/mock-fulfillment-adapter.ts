import {
  parseErpEnvironment,
  type ErpEnvironment,
} from "@b2b-portal/config/server";
import type { FulfillmentSource } from "../repositories/fulfillment.js";
import {
  FulfillmentError,
  checkedFulfillmentLink,
  checkedFulfillmentObservation,
  matchesFulfillment,
} from "../services/fulfillment.js";
/** Strict #134 wire translation; never forwards client controls or provider errors. */
export function createMockFulfillmentSource(
  config: ErpEnvironment,
  now = Date.now,
): FulfillmentSource {
  const parsed = parseErpEnvironment({
    ERP_BASE_URL: config.baseUrl,
    ERP_TIMEOUT_MS: String(config.timeoutMs),
  });
  if (!parsed) throw new FulfillmentError("unavailable");
  return {
    async read(expected, signal) {
      const link = checkedFulfillmentLink(expected),
        controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, parsed.timeoutMs);
      let response: Response | undefined,
        reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        response = await fetch(
          new URL(
            `orders/${link.erpOrderReference}/fulfillment`,
            parsed.baseUrl,
          ),
          {
            signal: controller.signal,
            redirect: "error",
            headers: { accept: "application/json" },
          },
        );
        if (
          !response.ok ||
          !/^application\/json(?:\s*;|\s*$)/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          !response.body
        )
          throw new Error();
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "",
          size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) throw new Error();
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        const row = JSON.parse(text);
        if (
          !row ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          Object.keys(row).sort().join(",") !==
            "customerId,erpOrderId,fulfillmentStatus,portalOrderId,updatedAt"
        )
          throw new Error();
        const mapping = {
          confirmed: "CONFIRMED",
          fulfilling: "FULFILLING",
          delivered: "DELIVERED",
        } as const;
        if (
          typeof row.fulfillmentStatus !== "string" ||
          !Object.hasOwn(mapping, row.fulfillmentStatus)
        )
          throw new Error();
        const observation = checkedFulfillmentObservation(
          {
            orderId: row.portalOrderId,
            erpOrderReference: row.erpOrderId,
            customerReference: row.customerId,
            status: mapping[row.fulfillmentStatus as keyof typeof mapping],
            updatedAt: row.updatedAt,
          },
          now(),
        );
        if (!matchesFulfillment(link, observation) || controller.signal.aborted)
          throw new Error();
        return observation;
      } catch {
        throw new FulfillmentError("unavailable");
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        } else await response?.body?.cancel().catch(() => {});
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
