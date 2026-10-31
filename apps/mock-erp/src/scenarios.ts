import { setTimeout as delay } from "node:timers/promises";
import { OrderError } from "./orders.js";

const scenarios = [
  "success",
  "completed",
  "timeout",
  "unavailable",
  "validation",
  "credit-hold",
  "insufficient-stock",
] as const;
export type OrderScenario = (typeof scenarios)[number];

export function parseScenario(value: string | undefined): OrderScenario {
  if (value === undefined) return "success";
  if (!scenarios.includes(value as OrderScenario))
    throw new OrderError(400, "INVALID_SCENARIO", "Unknown Mock ERP scenario.");
  return value as OrderScenario;
}

/** Explicit synthetic failures, not real stock/credit/commercial validation. */
export async function runScenario(
  scenario: OrderScenario,
  signal: AbortSignal,
  timeoutMs = 1500,
): Promise<void> {
  if (scenario === "success" || scenario === "completed") return;
  if (scenario === "timeout") {
    await delay(timeoutMs, undefined, { signal });
    throw new OrderError(504, "ERP_TIMEOUT", "Simulated ERP timeout.");
  }
  const failures = {
    unavailable: [
      503,
      "ERP_UNAVAILABLE",
      "Simulated ERP temporarily unavailable.",
    ],
    validation: [
      422,
      "ERP_VALIDATION_FAILED",
      "Simulated ERP validation failure.",
    ],
    "credit-hold": [422, "CREDIT_HOLD", "Simulated customer credit hold."],
    "insufficient-stock": [
      409,
      "INSUFFICIENT_STOCK",
      "Simulated insufficient stock.",
    ],
  } as const;
  const [status, code, message] = failures[scenario];
  throw new OrderError(status, code, message);
}
