import type { ApiFailure, ApiSuccess } from "./api.js";

export type DependencyHealth = "up" | "down" | "unconfigured" | "timeout";
export type StorageProvider = "postgresql" | "json";

export interface HealthReport {
  status: "up" | "degraded";
  api: { status: "up" };
  storage: { status: DependencyHealth; provider?: StorageProvider };
  erp: { status: DependencyHealth };
}

// Unready diagnostics extend the standard error, not the success envelope.
export type HealthResponse =
  | ApiSuccess<HealthReport>
  | (ApiFailure & {
      error: ApiFailure["error"] & { details: HealthReport };
    });
