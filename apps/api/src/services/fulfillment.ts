import type { AuditInput } from "../repositories/audit.js";
import type {
  FulfillmentActor,
  FulfillmentLink,
  FulfillmentObservation,
  FulfillmentRepository,
  FulfillmentSource,
  FulfillmentStatus,
} from "../repositories/fulfillment.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import { SessionError } from "./session-state.js";
export class FulfillmentError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Fulfillment refresh could not be confirmed.");
    this.name = "FulfillmentError";
  }
}
export function fulfillmentId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new FulfillmentError("invalid_input");
  return value.toLowerCase();
}
function reference(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    Array.from(value).some((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || (n >= 127 && n <= 159) || (n >= 0xd800 && n <= 0xdfff);
    })
  )
    throw new FulfillmentError("unavailable");
  return value;
}
export function checkedFulfillmentLink(
  value: FulfillmentLink,
): FulfillmentLink {
  if (
    !value ||
    !["SUBMITTED", "CONFIRMED", "FULFILLING", "DELIVERED"].includes(
      value.status,
    )
  )
    throw new FulfillmentError("conflict");
  try {
    return {
      companyId: fulfillmentId(value.companyId),
      orderId: fulfillmentId(value.orderId),
      erpOrderReference: fulfillmentId(value.erpOrderReference),
      customerReference: reference(value.customerReference),
      status: value.status,
    };
  } catch {
    throw new FulfillmentError("unavailable");
  }
}
export function checkedFulfillmentObservation(
  value: FulfillmentObservation,
  time: number,
): FulfillmentObservation {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "customerReference,erpOrderReference,orderId,status,updatedAt" ||
    !["CONFIRMED", "FULFILLING", "DELIVERED"].includes(value.status) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    new Date(value.updatedAt).toISOString() !== value.updatedAt ||
    Date.parse(value.updatedAt) > time
  )
    throw new FulfillmentError("unavailable");
  try {
    return {
      orderId: fulfillmentId(value.orderId),
      erpOrderReference: fulfillmentId(value.erpOrderReference),
      customerReference: reference(value.customerReference),
      status: value.status,
      updatedAt: value.updatedAt,
    };
  } catch {
    throw new FulfillmentError("unavailable");
  }
}
export function sameFulfillmentLink(
  a: FulfillmentLink,
  b: FulfillmentLink,
): boolean {
  return (
    a.companyId === b.companyId &&
    a.orderId === b.orderId &&
    a.erpOrderReference === b.erpOrderReference &&
    a.customerReference === b.customerReference
  );
}
export function matchesFulfillment(
  link: FulfillmentLink,
  observation: FulfillmentObservation,
): boolean {
  return (
    link.orderId === observation.orderId &&
    link.erpOrderReference === observation.erpOrderReference &&
    link.customerReference === observation.customerReference
  );
}
export function fulfillmentTransition(
  current: FulfillmentLink["status"],
  next: FulfillmentStatus,
): boolean {
  const ranks = { SUBMITTED: 0, CONFIRMED: 1, FULFILLING: 2, DELIVERED: 3 };
  if (
    !Object.hasOwn(ranks, current) ||
    !Object.hasOwn(ranks, next) ||
    ranks[next] < ranks[current as keyof typeof ranks]
  )
    throw new FulfillmentError("conflict");
  return current !== next;
}
export function fulfillmentExpiry(
  actor: FulfillmentActor,
  time: number,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new FulfillmentError("unavailable");
  if (
    !Number.isFinite(Date.parse(actor.accessExpiresAt)) ||
    time >= Date.parse(actor.accessExpiresAt)
  )
    throw new SessionError("invalid_proof");
}
export function createFulfillmentRefresh(
  repository: FulfillmentRepository,
  source: FulfillmentSource,
  audit: (input: AuditInput) => Promise<unknown>,
  now = Date.now,
) {
  return {
    async refresh(
      actor: AuthorizedActor,
      rawCompany: unknown,
      rawOrder: unknown,
      body: unknown,
      requestId: string,
      signal: AbortSignal,
    ) {
      requirePermission(actor, "orders.fulfillment.refresh");
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length
      )
        throw new FulfillmentError("invalid_input");
      const companyId = fulfillmentId(rawCompany),
        orderId = fulfillmentId(rawOrder),
        who = {
          userId: actor.userId,
          sessionId: actor.sessionId,
          accessExpiresAt: actor.accessExpiresAt,
        };
      fulfillmentExpiry(who, now(), signal);
      const link = checkedFulfillmentLink(
        await repository.capture(who, companyId, orderId, signal),
      );
      if (link.companyId !== companyId || link.orderId !== orderId)
        throw new FulfillmentError("unavailable");
      fulfillmentExpiry(who, now(), signal);
      let observation: FulfillmentObservation;
      try {
        observation = checkedFulfillmentObservation(
          await source.read(link, signal),
          now(),
        );
      } catch {
        throw new FulfillmentError("unavailable");
      }
      if (!matchesFulfillment(link, observation))
        throw new FulfillmentError("unavailable");
      fulfillmentExpiry(who, now(), signal);
      const result = await repository.apply(who, link, observation, signal);
      if (
        !result ||
        result.companyId !== companyId ||
        result.orderId !== orderId ||
        result.status !== observation.status ||
        typeof result.changed !== "boolean"
      )
        throw new FulfillmentError("unavailable");
      if (result.changed)
        try {
          await audit({
            companyId,
            actorUserId: who.userId,
            actorRole: "INTERNAL_ADMIN",
            action: "order.fulfillment_updated",
            targetType: "order",
            targetId: orderId,
            metadata: {
              requestId,
              orderId,
              outcome: "success",
              changedFields: ["status"],
            },
          });
        } catch {
          throw new FulfillmentError("unavailable");
        }
      return {
        orderId,
        companyId,
        status: result.status,
        changed: result.changed,
      };
    },
  };
}
export type FulfillmentService = ReturnType<typeof createFulfillmentRefresh>;
