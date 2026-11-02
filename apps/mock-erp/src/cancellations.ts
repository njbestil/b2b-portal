import { createHash, randomUUID } from "node:crypto";
import { OrderError, type MockErpOrder } from "./orders.js";

export interface MockErpCancellation {
  erpCancellationId: string;
  portalCancellationRequestId: string;
  erpOrderId: string;
  portalOrderId: string;
  customerId: string;
  reason: string;
  outcome: "approved" | "rejected";
  decidedAt: string;
  rejectionReason: string | null;
}
export type CancellationScenario =
  "approved" | "rejected" | "timeout" | "unavailable";
export function parseCancellationScenario(
  value: string | undefined,
): CancellationScenario {
  if (value === undefined) return "approved";
  if (!["approved", "rejected", "timeout", "unavailable"].includes(value))
    throw new OrderError(
      400,
      "INVALID_CANCELLATION_SCENARIO",
      "Unknown Mock cancellation scenario.",
    );
  return value as CancellationScenario;
}
function invalid(): never {
  throw new OrderError(
    400,
    "INVALID_CANCELLATION",
    "Invalid cancellation request.",
  );
}
function parse(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return invalid();
  const body = input as Record<string, unknown>;
  if (
    Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, "portalCancellationRequestId") ||
    !Object.hasOwn(body, "reason") ||
    typeof body.portalCancellationRequestId !== "string" ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(
      body.portalCancellationRequestId,
    ) ||
    typeof body.reason !== "string" ||
    !body.reason.trim() ||
    body.reason.length > 500 ||
    Array.from(body.reason).some((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || n === 127 || (n >= 0xd800 && n <= 0xdfff);
    })
  )
    return invalid();
  return {
    portalCancellationRequestId: body.portalCancellationRequestId.toLowerCase(),
    reason: body.reason.trim(),
  };
}

/** Trusted synthetic decisions only; portal owns permissions/business transitions. */
export function createCancellationService(
  findOrder: (id: string) => MockErpOrder,
) {
  const byKey = new Map<
    string,
    { fingerprint: string; record: MockErpCancellation }
  >();
  const requestIds = new Set<string>();
  function inspect(key: unknown, erpOrderId: string, input: unknown) {
    if (
      typeof key !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)
    )
      throw new OrderError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "A valid Idempotency-Key is required.",
      );
    const parsed = parse(input),
      order = findOrder(erpOrderId);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ erpOrderId: order.erpOrderId, ...parsed }))
      .digest("hex");
    const existing = byKey.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new OrderError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key is already used for a different cancellation request.",
        );
      return { key, parsed, order, fingerprint, existing: existing.record };
    }
    if (requestIds.has(parsed.portalCancellationRequestId))
      throw new OrderError(
        409,
        "CANCELLATION_ALREADY_EXISTS",
        "Cancellation request already has a Mock ERP decision.",
      );
    if (byKey.size >= 1000)
      throw new OrderError(
        503,
        "CANCELLATION_CAPACITY_REACHED",
        "Mock cancellation capacity reached.",
      );
    return { key, parsed, order, fingerprint, existing: undefined };
  }
  return {
    replay(
      key: unknown,
      id: string,
      input: unknown,
    ): MockErpCancellation | null {
      const { existing } = inspect(key, id, input);
      return existing ? structuredClone(existing) : null;
    },
    create(
      key: unknown,
      id: string,
      input: unknown,
      outcome: "approved" | "rejected" = "approved",
    ) {
      if (outcome !== "approved" && outcome !== "rejected") return invalid();
      const checked = inspect(key, id, input);
      if (checked.existing)
        return {
          created: false,
          cancellation: structuredClone(checked.existing),
        };
      const record: MockErpCancellation = {
        ...checked.parsed,
        erpCancellationId: randomUUID(),
        erpOrderId: checked.order.erpOrderId,
        portalOrderId: checked.order.portalOrderId,
        customerId: checked.order.customerId,
        outcome,
        decidedAt: new Date().toISOString(),
        rejectionReason:
          outcome === "rejected"
            ? "Simulated ERP cancellation rejection."
            : null,
      };
      // Synchronous publication is single-winner in this app's process.
      byKey.set(checked.key, { fingerprint: checked.fingerprint, record });
      requestIds.add(record.portalCancellationRequestId);
      return { created: true, cancellation: structuredClone(record) };
    },
  };
}
