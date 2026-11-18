import { SessionError } from "./session-state.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import {
  checkDependency,
  type DependencyProbe,
  type DependencyStatus,
} from "./dependency-health.js";
export interface DiagnosticsSources {
  readonly storage: {
    readonly provider: "postgresql" | "json";
    readonly probe: DependencyProbe;
  };
  readonly database: {
    readonly configured: boolean;
    readonly probe?: DependencyProbe;
  };
  readonly erp: {
    readonly provider: "mock" | null;
    readonly probe?: DependencyProbe;
  };
}
export interface DiagnosticsReport {
  readonly storage: {
    readonly provider: "postgresql" | "json";
    readonly status: DependencyStatus;
  };
  readonly database: {
    readonly provider: "postgresql";
    readonly configured: boolean;
    readonly status: Exclude<DependencyStatus, "unconfigured"> | "not_in_use";
  };
  readonly erp: {
    readonly provider: "mock" | null;
    readonly status: DependencyStatus;
  };
}
export class DiagnosticsError extends Error {
  constructor(readonly code: "busy" | "unavailable") {
    super("Diagnostics could not be confirmed.");
    this.name = "DiagnosticsError";
  }
}
export function createDiagnostics(
  sources: DiagnosticsSources,
  timeoutMs = 1000,
  now = Date.now,
) {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 1000 ||
    !["postgresql", "json"].includes(sources.storage.provider) ||
    typeof sources.storage.probe !== "function" ||
    typeof sources.database.configured !== "boolean" ||
    (sources.storage.provider === "postgresql" &&
      (!sources.database.configured ||
        typeof sources.database.probe !== "function")) ||
    (sources.erp.provider !== null && sources.erp.provider !== "mock") ||
    (sources.erp.provider === "mock" && typeof sources.erp.probe !== "function")
  )
    throw new TypeError("Invalid diagnostics configuration.");
  // Capture backend configuration, never reflect mutable source objects or callback data.
  const storageProvider = sources.storage.provider,
    storageProbe = sources.storage.probe,
    databaseConfigured = sources.database.configured,
    databaseProbe =
      storageProvider === "postgresql" ? sources.database.probe : undefined,
    erpProvider = sources.erp.provider,
    erpProbe = erpProvider === "mock" ? sources.erp.probe : undefined;
  let running = false;
  function checkAccess(actor: AuthorizedActor) {
    requirePermission(actor, "diagnostics.read");
    const expires = Date.parse(actor.accessExpiresAt);
    if (!Number.isFinite(expires) || now() >= expires)
      throw new SessionError("invalid_proof");
  }
  return {
    checkAccess,
    async report(actor: AuthorizedActor): Promise<DiagnosticsReport> {
      checkAccess(actor);
      if (running) throw new DiagnosticsError("busy");
      running = true;
      let pending = 0,
        finished = false;
      const settled = () => {
        pending--;
        if (finished && pending === 0) running = false;
      };
      const tracked = (
        probe: DependencyProbe | undefined,
      ): DependencyProbe | undefined =>
        probe
          ? (signal) => {
              const operation = Promise.resolve().then(() => probe(signal));
              pending++;
              void operation.then(settled, settled);
              return operation;
            }
          : undefined;
      try {
        const [storage, database, erp] = await Promise.all([
          checkDependency(tracked(storageProbe), timeoutMs),
          checkDependency(tracked(databaseProbe), timeoutMs),
          checkDependency(tracked(erpProbe), timeoutMs),
        ]);
        checkAccess(actor);
        return {
          storage: { provider: storageProvider, status: storage },
          database: {
            provider: "postgresql",
            configured: databaseConfigured,
            status:
              storageProvider === "json"
                ? "not_in_use"
                : database === "unconfigured"
                  ? "down"
                  : database,
          },
          erp: { provider: erpProvider, status: erp },
        };
      } finally {
        // Keep the slot for timed-out sources that ignore abort, until they settle.
        // Repeated requests therefore cannot accumulate abandoned probe work.
        finished = true;
        if (pending === 0) running = false;
      }
    },
  };
}
export type DiagnosticsService = ReturnType<typeof createDiagnostics>;
