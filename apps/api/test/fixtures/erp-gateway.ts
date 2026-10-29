import type { ErpGateway } from "../../src/integrations/erp-gateway.js";
import { MockErpAdapter } from "../../src/infrastructure/mock-erp-adapter.js";
import { createErpHealthProbe } from "../../src/services/erp-health.js";

const mock: ErpGateway = new MockErpAdapter({
  baseUrl: "http://127.0.0.1:3001/mock-erp/v1",
  timeoutMs: 1000,
});
const alternate: ErpGateway = {
  async checkAvailability(_signal) {
    return true;
  },
};
const result: Promise<boolean> = createErpHealthProbe(alternate)(
  new AbortController().signal,
);
void result;
// @ts-expect-error The neutral port requires cancellation, not a provider URL.
mock.checkAvailability();
const invalid: ErpGateway = {
  // @ts-expect-error Mock HTTP payloads cannot cross the application port.
  checkAvailability: async () => ({ status: "up" }),
};
const responseGateway: ErpGateway = {
  // @ts-expect-error HTTP response objects cannot cross the application port.
  checkAvailability: async () => new Response(),
};
void [invalid, responseGateway];
