import {
  parseErpEnvironment,
  type ErpEnvironment,
} from "@b2b-portal/config/server";
import type { ErpGateway } from "../integrations/erp-gateway.js";

/** The Mock ERP wire protocol is confined to this backend infrastructure adapter. */
export class MockErpAdapter implements ErpGateway {
  private readonly healthUrl: URL;
  private readonly timeoutMs: number;

  constructor(config: ErpEnvironment) {
    const validated = parseErpEnvironment({
      ERP_BASE_URL: config.baseUrl,
      ERP_TIMEOUT_MS: String(config.timeoutMs),
    });
    if (!validated)
      throw new TypeError("ERP_BASE_URL is required by the adapter.");
    this.healthUrl = new URL("health", validated.baseUrl);
    this.timeoutMs = validated.timeoutMs;
  }

  async checkAvailability(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let available: boolean;
    try {
      response = await fetch(this.healthUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
      if (
        !response.ok ||
        !/^application\/json(?:\s*;|\s*$)/i.test(
          response.headers.get("content-type") ?? "",
        ) ||
        !response.body
      )
        return false;
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "";
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) return false;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      const payload: unknown = JSON.parse(text);
      available =
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        "status" in payload &&
        payload.status === "up";
    } catch {
      // Unavailability is a defined result. Never expose upstream text/URLs/errors.
      available = false;
    } finally {
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      } else if (response?.body) {
        await response.body.cancel().catch(() => {});
      }
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    return available && !controller.signal.aborted;
  }
}
