import type { IntegrationMonitorRepository } from "../repositories/integration-monitor.js";
import { IntegrationMonitorError } from "../services/integration-monitor.js";
/** JSON has no durable integration-transaction producer; absence is not a healthy empty list. */
export function createUnavailableIntegrationMonitor(): IntegrationMonitorRepository {
  return {
    list: async () => {
      throw new IntegrationMonitorError("unavailable");
    },
    find: async () => {
      throw new IntegrationMonitorError("unavailable");
    },
  };
}
