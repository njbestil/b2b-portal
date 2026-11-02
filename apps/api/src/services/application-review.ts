import type { ApplicationRepository } from "../repositories/applications.js";
import { checkedPending } from "./applications.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
export function createApplicationReview(
  repository: Pick<ApplicationRepository, "pending">,
) {
  return async (actor: AuthorizedActor, companyId: string) => {
    requirePermission(actor, "applications.read");
    const application = await repository.pending(companyId);
    return application === null ? null : checkedPending(application);
  };
}
