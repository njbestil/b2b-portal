import type { DependencyHealth, StorageProvider } from "./health.js";
export interface AdminDiagnostics {
  readonly storage: {
    readonly provider: StorageProvider;
    readonly status: DependencyHealth;
  };
  readonly database: {
    readonly provider: "postgresql";
    readonly configured: boolean;
    readonly status: Exclude<DependencyHealth, "unconfigured"> | "not_in_use";
  };
  readonly erp: {
    readonly provider: "mock" | null;
    readonly status: DependencyHealth;
  };
}
