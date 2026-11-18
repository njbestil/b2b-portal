import {
  parseErpEnvironment,
  type ErpEnvironment,
} from "@b2b-portal/config/server";

export interface MockSubmissionRequest {
  externalRequestReference: string;
  portalOrderId: string;
  customerId: string;
  items: {
    productId: string;
    quantity: string;
    sellingUom: string;
    unitPrice: string;
    currency: string;
    snapshot: { sku: string; name: string };
  }[];
}
export type MockSubmissionResult =
  | { outcome: "accepted"; erpOrderReference: string }
  | { outcome: "rejected"; code: string }
  | { outcome: "uncertain" };

/** One attempt only. Any unverified response is uncertain: the mock ledger is
 * process-local, so callers must not automatically repeat an uncertain send. */
export function createMockSubmissionAdapter(config: ErpEnvironment) {
  const parsed = parseErpEnvironment({
    ERP_BASE_URL: config.baseUrl,
    ERP_TIMEOUT_MS: String(config.timeoutMs),
  });
  if (!parsed) throw new Error("Submission adapter unavailable.");
  return {
    async send(request: MockSubmissionRequest): Promise<MockSubmissionResult> {
      const payload = JSON.stringify(request);
      if (Buffer.byteLength(payload) > 32768) return { outcome: "uncertain" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), parsed.timeoutMs);
      try {
        const response = await fetch(new URL("submissions", parsed.baseUrl), {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: payload,
          redirect: "error",
          signal: controller.signal,
        });
        if (
          (response.status !== 200 && response.status !== 201) ||
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          !response.body
        ) {
          await response.body?.cancel();
          return { outcome: "uncertain" };
        }
        const reader = response.body.getReader(),
          decoder = new TextDecoder("utf-8", { fatal: true });
        let size = 0,
          text = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) return { outcome: "uncertain" };
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const receipt = JSON.parse(text);
        if (
          !receipt ||
          typeof receipt !== "object" ||
          receipt.externalRequestReference !==
            request.externalRequestReference ||
          receipt.portalOrderId !== request.portalOrderId ||
          receipt.customerId !== request.customerId
        )
          return { outcome: "uncertain" };
        if (
          receipt.outcome === "rejected" &&
          [
            "ERP_VALIDATION_FAILED",
            "CREDIT_HOLD",
            "INSUFFICIENT_STOCK",
            "INVALID_ITEM",
          ].includes(receipt.rejection?.code)
        )
          return { outcome: "rejected", code: receipt.rejection.code };
        const order = receipt.order;
        if (
          !["accepted", "existing-order"].includes(receipt.outcome) ||
          !order ||
          order.portalOrderId !== request.portalOrderId ||
          order.customerId !== request.customerId ||
          order.status !== "created" ||
          typeof order.erpOrderId !== "string" ||
          !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(
            order.erpOrderId,
          ) ||
          !Array.isArray(order.items) ||
          order.items.length !== request.items.length ||
          order.items.some((item: Record<string, unknown>, index: number) => {
            const expected = request.items[index];
            const snapshot = item?.snapshot as
              Record<string, unknown> | undefined;
            return (
              !expected ||
              !item ||
              item.productId !== expected.productId ||
              item.quantity !== expected.quantity ||
              item.sellingUom !== expected.sellingUom ||
              item.unitPrice !== expected.unitPrice ||
              item.currency !== expected.currency ||
              snapshot?.sku !== expected.snapshot.sku ||
              snapshot?.name !== expected.snapshot.name
            );
          })
        )
          return { outcome: "uncertain" };
        return { outcome: "accepted", erpOrderReference: order.erpOrderId };
      } catch {
        return { outcome: "uncertain" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
