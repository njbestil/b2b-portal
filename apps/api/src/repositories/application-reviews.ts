import type { PendingApplication } from "./applications.js";

export interface ReviewActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessExpiresAt: string;
}
export type EffectState = "pending" | "unknown" | "completed";
export interface ReviewedApplication extends PendingApplication {
  readonly version: string;
  readonly status: "PENDING" | "APPROVED" | "REJECTED";
  readonly rejectionReason: string | null;
  readonly auditState: EffectState;
  readonly notificationState: EffectState;
}
/** Private durable decision, never an HTTP projection. */
export interface ApplicationDecision {
  readonly application: ReviewedApplication;
  readonly originalVersion: string;
  readonly actorUserId: string;
  readonly decidedAt: string;
}
export interface ReviewCommand {
  readonly version: string;
  readonly decision: "approve" | "reject";
  readonly reason: string | null;
}
export interface ApplicationReviewRepository {
  list(
    actor: ReviewActor,
    offset: number,
    limit: number,
  ): Promise<{ items: ReviewedApplication[]; total: number }>;
  detail(actor: ReviewActor, id: string): Promise<ReviewedApplication | null>;
  decide(
    actor: ReviewActor,
    id: string,
    command: ReviewCommand,
  ): Promise<ApplicationDecision>;
  /** Compare-and-set claim prevents concurrent/replayed effect invocation. */
  effect(
    actor: ReviewActor,
    id: string,
    key: "auditState" | "notificationState",
    expected: EffectState,
    next: EffectState,
  ): Promise<boolean>;
}
