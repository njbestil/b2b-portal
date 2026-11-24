/** Only correlated Mock responses documented to have produced no ERP order. */
export function retryableSubmission(
  value: unknown,
): value is { outcome: "rejected"; code: string } {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    result.outcome === "rejected" &&
    ["ERP_TEMPORARY_FAILURE", "ERP_UNAVAILABLE", "ERP_TIMEOUT"].includes(
      result.code as string,
    )
  );
}
