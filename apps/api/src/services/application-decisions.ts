import type {
  ApplicationReviewRepository,
  ReviewActor,
  ReviewCommand,
  ReviewedApplication,
} from "../repositories/application-reviews.js";
import type { AuditInput } from "../repositories/audit.js";
import type { NotificationInput } from "../repositories/notifications.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import { applicationId, applicationText } from "./applications.js";

export class ReviewError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Application review could not be confirmed.");
    this.name = "ReviewError";
  }
}
function identity(actor: AuthorizedActor): ReviewActor {
  requirePermission(actor, "applications.read");
  return {
    userId: actor.userId,
    sessionId: actor.sessionId,
    accessExpiresAt: actor.accessExpiresAt,
  };
}
function id(input: unknown) {
  try {
    return applicationId(input);
  } catch {
    throw new ReviewError("invalid_input");
  }
}
function command(value: unknown): ReviewCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewError("invalid_input");
  const body = value as Record<string, unknown>;
  if (
    typeof body.version !== "string" ||
    !/^pending-[\da-f]{64}$/.test(body.version) ||
    !["approve", "reject"].includes(body.decision as string) ||
    Object.keys(body).sort().join(",") !==
      (body.decision === "approve"
        ? "decision,version"
        : "decision,reason,version")
  )
    throw new ReviewError("invalid_input");
  try {
    return {
      version: body.version,
      decision: body.decision as ReviewCommand["decision"],
      reason:
        body.decision === "reject" ? applicationText(body.reason, 1000) : null,
    };
  } catch {
    throw new ReviewError("invalid_input");
  }
}
/** Deliberate public whitelist. No internal linkage, actor or credential fields. */
function view(row: ReviewedApplication) {
  const {
    administratorUserId: _user,
    deliveryAddressId: _address,
    ...publicRow
  } = row;
  void _user;
  void _address;
  return publicRow;
}
export function createApplicationDecisions(
  repository: ApplicationReviewRepository,
  audit: (input: AuditInput) => Promise<unknown>,
  notify: (input: NotificationInput) => Promise<unknown>,
) {
  return {
    async list(actor: AuthorizedActor, offset: number, limit: number) {
      const who = identity(actor);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 100000 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new ReviewError("invalid_input");
      const result = await repository.list(who, offset, limit);
      return { ...result, items: result.items.map(view) };
    },
    async detail(actor: AuthorizedActor, key: unknown) {
      const row = await repository.detail(identity(actor), id(key));
      if (!row) throw new ReviewError("not_found");
      return { application: view(row) };
    },
    async decide(
      actor: AuthorizedActor,
      key: unknown,
      input: unknown,
      requestId: string,
    ) {
      const who = identity(actor),
        companyId = id(key),
        decision = await repository.decide(who, companyId, command(input));
      const approved = decision.application.status === "APPROVED";
      for (const effect of ["auditState", "notificationState"] as const) {
        if (
          await repository.effect(who, companyId, effect, "pending", "unknown")
        ) {
          try {
            if (effect === "auditState")
              await audit({
                companyId,
                actorUserId: decision.actorUserId,
                actorRole: "INTERNAL_ADMIN",
                action: approved
                  ? "application.approved"
                  : "application.rejected",
                targetType: "company",
                targetId: companyId,
                metadata: { requestId, outcome: "success" },
              });
            else
              await notify({
                userId: decision.application.administratorUserId,
                type: approved
                  ? "application.approved"
                  : "application.rejected",
                title: approved
                  ? "Application approved"
                  : "Application rejected",
                message: approved
                  ? "Your business application was approved. Sign in and complete the required password change."
                  : "Your business application was rejected. Reason: " +
                    decision.application.rejectionReason,
                targetType: "company",
                targetId: companyId,
              });
            await repository.effect(
              who,
              companyId,
              effect,
              "unknown",
              "completed",
            );
          } catch {
            /* The transition is committed; unknown is retained, never blindly retried. */
          }
        }
      }
      return this.detail(actor, companyId);
    },
  };
}
export type ApplicationDecisionService = ReturnType<
  typeof createApplicationDecisions
>;
