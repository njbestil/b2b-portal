import {
  parseErpEnvironment,
  type ErpEnvironment,
} from "@b2b-portal/config/server";

export interface CancellationRequest {
  readonly requestId: string;
  readonly orderId: string;
  readonly erpOrderId: string;
  readonly customerReference: string;
  readonly reason: string;
}
export type CancellationDecision =
  | { outcome: "approved" | "rejected"; decidedAt: string }
  | { outcome: "unknown" };

/** One attempt only: Mock's process-local ledger cannot protect a retry after restart. */
export function createMockCancellationAdapter(config: ErpEnvironment) {
  const settings = parseErpEnvironment({
    ERP_BASE_URL: config.baseUrl,
    ERP_TIMEOUT_MS: String(config.timeoutMs),
  });
  if (!settings) throw Error("Cancellation provider unavailable.");
  return {
    async cancel(input: CancellationRequest): Promise<CancellationDecision> {
      const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
      if (
        !input ||
        !uuid.test(input.requestId) ||
        !uuid.test(input.orderId) ||
        !uuid.test(input.erpOrderId) ||
        typeof input.customerReference !== "string" ||
        !input.customerReference.trim() ||
        input.customerReference.length > 256 ||
        Array.from(input.customerReference).some((c) => {
          const n = c.codePointAt(0)!;
          return (
            n < 32 || (n >= 127 && n <= 159) || (n >= 0xd800 && n <= 0xdfff)
          );
        })
      )
        return { outcome: "unknown" };
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      try {
        const response = await fetch(
          new URL(`orders/${input.erpOrderId}/cancellations`, settings.baseUrl),
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "idempotency-key": input.requestId,
            },
            body: JSON.stringify({
              portalCancellationRequestId: input.requestId,
              reason: input.reason,
            }),
            redirect: "error",
            signal: controller.signal,
          },
        );
        if (
          ![200, 201].includes(response.status) ||
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          !response.body
        ) {
          await response.body?.cancel();
          return { outcome: "unknown" };
        }
        const reader = response.body.getReader(),
          decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "",
          size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4096) return { outcome: "unknown" };
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const row = JSON.parse(text);
        if (
          !row ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          Object.keys(row).sort().join(",") !==
            "customerId,decidedAt,erpCancellationId,erpOrderId,outcome,portalCancellationRequestId,portalOrderId,reason,rejectionReason" ||
          row.portalCancellationRequestId !== input.requestId ||
          row.erpOrderId !== input.erpOrderId ||
          row.portalOrderId !== input.orderId ||
          row.customerId !== input.customerReference ||
          row.reason !== input.reason ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
            row.erpCancellationId,
          ) ||
          !["approved", "rejected"].includes(row.outcome) ||
          typeof row.decidedAt !== "string" ||
          !Number.isFinite(Date.parse(row.decidedAt)) ||
          new Date(row.decidedAt).toISOString() !== row.decidedAt ||
          Date.parse(row.decidedAt) > Date.now() ||
          (row.outcome === "approved"
            ? row.rejectionReason !== null
            : typeof row.rejectionReason !== "string")
        )
          return { outcome: "unknown" };
        return { outcome: row.outcome, decidedAt: row.decidedAt };
      } catch {
        return { outcome: "unknown" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
