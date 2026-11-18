/** Backend-only read-only probes. Returned states never include callback payloads. */
export type DependencyProbe = (signal: AbortSignal) => Promise<boolean>;
export type DependencyStatus = "up" | "down" | "unconfigured" | "timeout";

export async function checkDependency(
  probe: DependencyProbe | undefined,
  timeoutMs: number,
): Promise<DependencyStatus> {
  if (!probe) return "unconfigured";

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DependencyStatus>((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
      controller.abort();
    }, timeoutMs);
  });
  // Schedule invocation inside a promise to also contain synchronous throws.
  const result = Promise.resolve()
    .then(() => probe(controller.signal))
    .then<DependencyStatus, DependencyStatus>(
      (healthy) => (healthy === true ? "up" : "down"),
      () => "down",
    );
  try {
    return await Promise.race([result, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
