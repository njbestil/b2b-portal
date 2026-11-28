import type { StoredConfirmation } from "../repositories/confirmation-requests.js";
import type {
  CustomerConfirmations,
  CustomerConfirmationActor,
  ConfirmationDecision,
  ConfirmationReview,
} from "../repositories/customer-confirmations.js";
import type { AuditInput } from "../repositories/audit.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import { checkedConfirmation, rejectionReason } from "./confirmation-record.js";
export { checkedConfirmation, rejectionReason } from "./confirmation-record.js";
import { draftId, DraftError } from "./order-drafts.js";
import { checkedDraftItems } from "./draft-quantities.js";
export function customerDecisionAllowed(
  a: CustomerConfirmationActor,
  record: StoredConfirmation,
) {
  if (
    record.companyId !== a.companyId ||
    (a.role !== "CUSTOMER_ADMIN" && record.customerUserId !== a.userId)
  )
    throw new DraftError("not_found");
}
export function decisionReplay(
  record: StoredConfirmation,
  actor: CustomerConfirmationActor,
  input: ConfirmationDecision,
) {
  const r = checkedConfirmation(record);
  if (r.status === "PENDING") return false;
  if (
    r.status !== input.status ||
    r.reason !== input.reason ||
    r.decidedByUserId !== actor.userId
  )
    throw new DraftError("conflict");
  return true;
}
const text = (v: unknown, limit = 256): v is string =>
  typeof v === "string" &&
  !!v.trim() &&
  v.length <= limit &&
  !Array.from(v).some((c) => {
    const n = c.codePointAt(0)!;
    return n < 32 || n === 127 || (n >= 0xd800 && n <= 0xdfff);
  });
function publicReview(
  value: ConfirmationReview,
  actor: CustomerConfirmationActor,
  id: string,
) {
  const c = checkedConfirmation(value.confirmation);
  customerDecisionAllowed(actor, c);
  if (
    c.orderId !== id ||
    value.order.id !== id ||
    !text(value.order.createdBy, 160) ||
    ![
      "PENDING_CUSTOMER_CONFIRMATION",
      "REJECTED",
      ...(c.status === "CONFIRMED"
        ? ["SUBMITTED", "CONFIRMED", "FULFILLING", "DELIVERED", "CANCELLED"]
        : []),
    ].includes(value.order.status) ||
    value.order.items.length > 100 ||
    !value.order.items.length ||
    (value.order.delivery &&
      (!text(value.order.delivery.label, 160) ||
        !text(value.order.delivery.line1, 500)))
  )
    throw new DraftError("unavailable");
  checkedDraftItems(
    value.order.items.map(({ id, productId, quantity }) => ({
      id,
      productId,
      quantity,
    })),
  );
  if (
    value.order.items.some(
      (r) => !text(r.name) || !text(r.sku) || !text(r.sellingUom, 64),
    )
  )
    throw new DraftError("unavailable");
  return {
    canSubmit:
      c.status === "CONFIRMED" &&
      c.decidedByUserId === actor.userId &&
      value.order.status === "PENDING_CUSTOMER_CONFIRMATION",
    confirmation: {
      id: c.id,
      orderId: c.orderId,
      customerUserId: c.customerUserId,
      status: c.status,
      createdAt: c.createdAt,
      ...(c.status === "PENDING"
        ? {}
        : { decidedAt: c.decidedAt, reason: c.reason }),
    },
    order: {
      id,
      status: value.order.status,
      createdBy: value.order.createdBy,
      items: value.order.items.map((r) => ({
        id: r.id,
        productId: r.productId,
        quantity: r.quantity,
        name: r.name,
        sku: r.sku,
        sellingUom: r.sellingUom,
      })),
      delivery: value.order.delivery
        ? {
            label: value.order.delivery.label,
            line1: value.order.delivery.line1,
          }
        : null,
    },
  };
}
export function createCustomerConfirmations(
  repository: CustomerConfirmations,
  audit: (input: AuditInput) => Promise<unknown>,
) {
  const who = (a: AuthorizedActor): CustomerConfirmationActor => {
    requirePermission(a, "orders.confirmation.decide");
    if (a.role !== "CUSTOMER_ADMIN" && a.role !== "CUSTOMER_USER")
      throw new DraftError("forbidden");
    return {
      userId: a.userId,
      companyId: draftId(a.companyId),
      sessionId: a.sessionId,
      accessExpiresAt: a.accessExpiresAt,
      role: a.role,
    };
  };
  return {
    async find(a: AuthorizedActor, input: unknown) {
      const actor = who(a),
        id = draftId(input);
      return publicReview(await repository.find(actor, id), actor, id);
    },
    async decide(
      a: AuthorizedActor,
      input: unknown,
      body: unknown,
      requestId: string,
    ) {
      const actor = who(a),
        id = draftId(input);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).sort().join(",") !== "confirmationId,decision,reason"
      )
        throw new DraftError("invalid_input");
      const b = body as {
        confirmationId: unknown;
        decision: unknown;
        reason: unknown;
      };
      if (
        !["CONFIRMED", "REJECTED"].includes(b.decision as string) ||
        (b.decision === "CONFIRMED" && b.reason !== null)
      )
        throw new DraftError("invalid_input");
      const decision: ConfirmationDecision = {
        status: b.decision as ConfirmationDecision["status"],
        reason: b.decision === "REJECTED" ? rejectionReason(b.reason) : null,
      };
      const result = publicReview(
        await repository.decide(actor, id, draftId(b.confirmationId), decision),
        actor,
        id,
      );
      try {
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action:
            decision.status === "CONFIRMED"
              ? "order.customer_confirmed"
              : "order.customer_rejected",
          targetType: "order",
          targetId: id,
          metadata: {
            requestId,
            orderId: id,
            outcome: "success",
          },
        });
      } catch {
        throw new DraftError("unavailable");
      }
      return result;
    },
  };
}
export type CustomerConfirmationService = ReturnType<
  typeof createCustomerConfirmations
>;
