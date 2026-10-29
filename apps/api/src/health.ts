import type { DependencyHealth, HealthReport } from "@b2b-portal/contracts";

// Adapters supply read-only probes once implemented; absence is not success.
export type HealthProbe = (signal: AbortSignal) => Promise<boolean>;

export interface HealthChecks {
  storage?: HealthProbe;
  erp?: HealthProbe;
}

async function checkDependency(
  probe: HealthProbe | undefined,
  timeoutMs: number,
): Promise<DependencyHealth> {
  if (!probe) return "unconfigured";

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DependencyHealth>((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
      controller.abort();
    }, timeoutMs);
  });
  // Schedule invocation inside a promise to also contain synchronous throws.
  const result = Promise.resolve()
    .then(() => probe(controller.signal))
    .then<DependencyHealth, DependencyHealth>(
      (healthy) => (healthy === true ? "up" : "down"),
      () => "down",
    );
  try {
    return await Promise.race([result, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function createHealthReporter(
  checks: HealthChecks = {},
  timeoutMs = 1000,
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
      storage: { status: storage },
      erp: { status: erp },
    };
  };
}
