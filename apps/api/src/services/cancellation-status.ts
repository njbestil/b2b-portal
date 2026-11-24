import type { CancellationStatusRepository } from "../repositories/cancellation-status.js";
import type { CompanyProfileRepository } from "../repositories/company-profiles.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import { profileId } from "./company-profiles.js";
import { CancellationError } from "./cancellation.js";
export function createCancellationStatus(
  repository: CancellationStatusRepository,
  profiles: CompanyProfileRepository,
) {
  return async (
    actor: AuthorizedActor,
    company: unknown,
    order: unknown,
    signal: AbortSignal,
  ) => {
    requirePermission(actor, "orders.cancel");
    const companyId = profileId(company),
      orderId = profileId(order);
    if (signal.aborted) throw new CancellationError("unavailable");
    const who = {
      userId: actor.userId,
      sessionId: actor.sessionId,
      accessExpiresAt: actor.accessExpiresAt,
      companyId: actor.companyId,
      role: actor.role,
    };
    await profiles.read(who, companyId);
    const result = await repository.latest(companyId, orderId);
    if (!result) throw new CancellationError("not_found");
    if (
      result.orderStatus === "DRAFT" &&
      result.createdByUserId !== actor.userId
    )
      throw new CancellationError("forbidden");
    await profiles.read(who, companyId);
    if (signal.aborted) throw new CancellationError("unavailable");
    const value = result.cancellation;
    if (
      value &&
      (value.orderId !== orderId ||
        !["PENDING", "APPROVED", "REJECTED"].includes(value.status) ||
        typeof value.requestId !== "string" ||
        !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value.requestId))
    )
      throw new CancellationError("unavailable");
    return {
      cancellation: value
        ? {
            requestId: profileId(value.requestId),
            orderId,
            status: value.status,
          }
        : null,
    };
  };
}
export type CancellationStatusReader = ReturnType<
  typeof createCancellationStatus
>;
