export class ManualRetryError extends Error {
  constructor(
    readonly code: "invalid_input" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Manual retry could not be confirmed.");
    this.name = "ManualRetryError";
  }
}
export function checkedRetryVersion(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ManualRetryError("invalid_input");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 2 ||
    !Number.isSafeInteger(row.retryCount) ||
    (row.retryCount as number) < 0 ||
    (row.retryCount as number) >= 2147483647 ||
    typeof row.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    new Date(row.updatedAt).toISOString() !== row.updatedAt
  )
    throw new ManualRetryError("invalid_input");
  return { retryCount: row.retryCount as number, updatedAt: row.updatedAt };
}
