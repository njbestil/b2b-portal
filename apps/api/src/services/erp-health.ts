import type { ErpGateway } from "../integrations/erp-gateway.js";
import type { HealthProbe } from "../health.js";

/** Application-side consumer depends on the port, not an HTTP/provider class. */
export function createErpHealthProbe(gateway: ErpGateway): HealthProbe {
  return (signal) => gateway.checkAvailability(signal);
}
