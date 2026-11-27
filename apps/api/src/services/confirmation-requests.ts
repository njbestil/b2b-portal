import type {
  ConfirmationActor,
  ConfirmationRequests,
  PendingConfirmation,
} from "../repositories/confirmation-requests.js";
import type { AuditInput } from "../repositories/audit.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import { draftId, DraftError } from "./order-drafts.js";
export function checkedPendingConfirmation(
  value: PendingConfirmation,
): PendingConfirmation {
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "companyId,createdAt,customerUserId,fingerprint,id,orderId,status" ||
    value.status !== "PENDING" ||
    typeof value.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  )
    throw new DraftError("unavailable");
  return {
    id: draftId(value.id),
    companyId: draftId(value.companyId),
    orderId: draftId(value.orderId),
    customerUserId: draftId(value.customerUserId),
    status: "PENDING",
    createdAt: value.createdAt,
    fingerprint: value.fingerprint,
  };
}
function who(actor: AuthorizedActor, company: unknown): ConfirmationActor {
  requirePermission(actor, "sales-drafts.manage");
  if (actor.role !== "SALES_STAFF") throw new DraftError("forbidden");
  return {
    userId: actor.userId,
    sessionId: actor.sessionId,
    accessExpiresAt: actor.accessExpiresAt,
    role: "SALES_STAFF",
    companyId: draftId(company),
  };
}
const view = (input: PendingConfirmation) => {
  const r = checkedPendingConfirmation(input);
  return {
    id: r.id,
    orderId: r.orderId,
    customerUserId: r.customerUserId,
    status: r.status,
    createdAt: r.createdAt,
  };
};
export function createConfirmationRequests(
  repository: ConfirmationRequests,
  audit: (input: AuditInput) => Promise<unknown>,
) {
  return {
    async request(
      actor: AuthorizedActor,
      company: unknown,
      order: unknown,
      key: unknown,
      input: unknown,
      requestId: string,
    ) {
      const a = who(actor, company),
        id = draftId(order);
      if (
        typeof key !== "string" ||
        !/^[!-~]{1,128}$/.test(key) ||
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(",") !== "customerUserId,version"
      )
        throw new DraftError("invalid_input");
      const body = input as { version: unknown; customerUserId: unknown };
      if (
        typeof body.version !== "string" ||
        !/^draft-[a-f0-9]{64}$/.test(body.version)
      )
        throw new DraftError("invalid_input");
      const r = await repository.request(
        a,
        id,
        body.version,
        draftId(body.customerUserId),
        key,
      );
      if (r.orderId !== id || r.companyId !== a.companyId)
        throw new DraftError("unavailable");
      try {
        await audit({
          companyId: a.companyId,
          actorUserId: a.userId,
          actorRole: a.role,
          action: "order.confirmation_requested",
          targetType: "order",
          targetId: id,
          metadata: { requestId, orderId: id, outcome: "success" },
        });
      } catch {
        throw new DraftError("unavailable");
      }
      return { confirmation: view(r) };
    },
    async find(actor: AuthorizedActor, company: unknown, order: unknown) {
      const a = who(actor, company),
        id = draftId(order),
        r = await repository.find(a, id);
      if (r && (r.companyId !== a.companyId || r.orderId !== id))
        throw new DraftError("unavailable");
      return { confirmation: r ? view(r) : null };
    },
  };
}
export type ConfirmationRequestService = ReturnType<
  typeof createConfirmationRequests
>;
