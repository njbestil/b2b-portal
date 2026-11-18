import {
  checkDependency,
  type DependencyProbe,
} from "./services/dependency-health.js";
import type { HealthReport, StorageProvider } from "@b2b-portal/contracts";

// Adapters supply read-only probes once implemented; absence is not success.
export type HealthProbe = DependencyProbe;

export interface HealthChecks {
  storage?: HealthProbe;
  erp?: HealthProbe;
}

export function createHealthReporter(
  checks: HealthChecks = {},
  timeoutMs = 1000,
  storageProvider?: StorageProvider,
): () => Promise<HealthReport> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError(
      "Health timeout must be an integer from 1 to 60000 ms",
    );
  }
  return async () => {
    const [storage, erp] = await Promise.all([
      checkDependency(checks.storage, timeoutMs),
      checkDependency(checks.erp, timeoutMs),
    ]);
    return {
      status: storage === "up" && erp === "up" ? "up" : "degraded",
      api: { status: "up" },
      storage: {
        status: storage,
        ...(storageProvider ? { provider: storageProvider } : {}),
      },
      erp: { status: erp },
    };
  };
}
