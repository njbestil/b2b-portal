import { requirePermission, type AuthorizedActor } from "./authorization.js";
export class CancellationError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Cancellation could not be confirmed.");
  }
}
export function cancellationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new CancellationError("invalid_input");
  return value.toLowerCase();
}
export function cancellationReason(value: unknown): string {
  if (typeof value !== "string") throw new CancellationError("invalid_input");
  const reason = value.trim();
  if (
    !reason ||
    reason.length > 500 ||
    Array.from(reason).some((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || (n >= 127 && n <= 159) || (n >= 0xd800 && n <= 0xdfff);
    })
  )
    throw new CancellationError("invalid_input");
  return reason;
}
export function cancellationActor(actor: AuthorizedActor, rawCompany: unknown) {
  requirePermission(actor, "orders.cancel");
  const companyId = cancellationId(rawCompany);
  if (actor.role !== "SALES_STAFF" && actor.companyId !== companyId)
    throw new CancellationError("not_found");
  return {
    companyId,
    userId: cancellationId(actor.userId),
    sessionId: cancellationId(actor.sessionId),
    role: actor.role,
    accessExpiresAt: actor.accessExpiresAt,
  };
}
