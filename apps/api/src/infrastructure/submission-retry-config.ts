import { EnvironmentConfigurationError } from "@b2b-portal/config/server";

export interface SubmissionRetryPolicy {
  readonly maxRetries: number;
  readonly delayMs: number;
}
export function parseSubmissionRetryPolicy(
  env: Readonly<Record<string, string | undefined>>,
): SubmissionRetryPolicy {
  const limit = env.ERP_SUBMISSION_MAX_RETRIES ?? "2",
    delay = env.ERP_SUBMISSION_RETRY_DELAY_MS ?? "1000";
  const maxRetries = Number(limit),
    delayMs = Number(delay);
  if (
    !/^\d+$/.test(limit) ||
    !Number.isInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > 5 ||
    !/^\d+$/.test(delay) ||
    !Number.isInteger(delayMs) ||
    delayMs < 100 ||
    delayMs > 5000
  )
    throw new EnvironmentConfigurationError([
      "Invalid ERP submission retry configuration",
    ]);
  return { maxRetries, delayMs };
}
