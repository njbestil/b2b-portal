import type {
  AccountStatusRepository,
  StatusTargetKind,
  StatusTarget,
} from "../repositories/account-status.js";
import type { AuditInput } from "../repositories/audit.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
export class AccountStatusError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Account status could not be confirmed.");
    this.name = "AccountStatusError";
  }
}
export function statusId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new AccountStatusError("invalid_input");
  return value.toLowerCase();
}
const view = (target: StatusTarget) => ({
  target: { id: target.id, kind: target.kind, status: target.status },
});
export function createAccountStatus(
  repository: AccountStatusRepository,
  audit: (event: AuditInput) => Promise<unknown>,
) {
  return {
    async current(actor: AuthorizedActor, kind: StatusTargetKind, id: unknown) {
      requirePermission(actor, "accounts.status.read");
      return view(await repository.current(actor, kind, statusId(id)));
    },
    async change(
      actor: AuthorizedActor,
      kind: StatusTargetKind,
      id: unknown,
      value: unknown,
      requestId: string,
    ) {
      requirePermission(actor, "accounts.status.write");
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "expectedStatus,status"
      )
        throw new AccountStatusError("invalid_input");
      const { expectedStatus, status } = value as Record<string, unknown>;
      if (
        (expectedStatus !== "ACTIVE" && expectedStatus !== "SUSPENDED") ||
        (status !== "ACTIVE" && status !== "SUSPENDED") ||
        expectedStatus === status
      )
        throw new AccountStatusError("invalid_input");
      const target = await repository.change(
        actor,
        kind,
        statusId(id),
        expectedStatus,
        status,
      );
      try {
        await audit({
          companyId: target.companyId,
          actorUserId: actor.userId,
          actorRole: "INTERNAL_ADMIN",
          action:
            target.kind +
            "." +
            (status === "ACTIVE" ? "reactivated" : "suspended"),
          targetType: target.kind,
          targetId: target.id,
          metadata: {
            requestId,
            outcome: "success",
            reasonCode:
              status === "ACTIVE" ? "ACCOUNT_REACTIVATED" : "ACCOUNT_SUSPENDED",
          },
        });
      } catch {
        throw new AccountStatusError("unavailable");
      }
      return view(target);
    },
  };
}
export type AccountStatusService = ReturnType<typeof createAccountStatus>;
