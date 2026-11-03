import { createHash, randomUUID } from "node:crypto";
import type { PendingApplication } from "../repositories/applications.js";
import type {
  ApplicationDecision,
  ReviewedApplication,
  ReviewActor,
  ReviewCommand,
} from "../repositories/application-reviews.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord } from "../repositories/sessions.js";
import {
  checkedPending,
  applicationId,
  applicationText,
} from "../services/applications.js";
import { ReviewError } from "../services/application-decisions.js";
import { eligible, SessionError } from "../services/session-state.js";
import { bound } from "./session-crypto.js";

export function reviewActor(
  identity: ReviewActor,
  account: LoginCredential | null,
  session: SessionRecord | null,
  time: number,
) {
  applicationId(identity.userId);
  applicationId(identity.sessionId);
  const user = eligible(account);
  if (
    user.id !== identity.userId ||
    user.role !== "INTERNAL_ADMIN" ||
    user.companyId !== null
  )
    throw new ReviewError("forbidden");
  if (user.mustChangePassword) throw new SessionError("restricted");
  if (
    !Number.isFinite(Date.parse(identity.accessExpiresAt)) ||
    time >= Date.parse(identity.accessExpiresAt)
  )
    throw new SessionError("invalid_proof");
  bound(session, user, time);
}
export function pendingReview(input: PendingApplication): ReviewedApplication {
  const pending = checkedPending(input);
  return {
    ...pending,
    version:
      "pending-" +
      createHash("sha256").update(JSON.stringify(pending)).digest("hex"),
    status: "PENDING",
    rejectionReason: null,
    auditState: "pending",
    notificationState: "pending",
  };
}
export function newDecision(
  pending: ReviewedApplication,
  actor: ReviewActor,
  command: ReviewCommand,
  time: number,
): ApplicationDecision {
  if (pending.status !== "PENDING" || pending.version !== command.version)
    throw new ReviewError("conflict");
  return {
    originalVersion: pending.version,
    actorUserId: actor.userId,
    decidedAt: new Date(time).toISOString(),
    application: {
      ...pending,
      version: "decision-" + randomUUID(),
      status: command.decision === "approve" ? "APPROVED" : "REJECTED",
      rejectionReason: command.reason,
    },
  };
}
export function replay(decision: ApplicationDecision, command: ReviewCommand) {
  if (
    decision.originalVersion !== command.version ||
    decision.application.status !==
      (command.decision === "approve" ? "APPROVED" : "REJECTED") ||
    decision.application.rejectionReason !== command.reason
  )
    throw new ReviewError("conflict");
  return decision;
}
export function checkedDecision(
  input: ApplicationDecision,
): ApplicationDecision {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).sort().join(",") !==
      "actorUserId,application,decidedAt,originalVersion"
  )
    throw new ReviewError("unavailable");
  const a = input.application;
  if (
    !a ||
    !["APPROVED", "REJECTED"].includes(a.status) ||
    !/^decision-[\da-f-]{36}$/.test(a.version) ||
    !/^pending-[\da-f]{64}$/.test(input.originalVersion) ||
    typeof input.decidedAt !== "string" ||
    !Number.isFinite(Date.parse(input.decidedAt)) ||
    new Date(input.decidedAt).toISOString() !== input.decidedAt ||
    !["pending", "unknown", "completed"].includes(a.auditState) ||
    !["pending", "unknown", "completed"].includes(a.notificationState)
  )
    throw new ReviewError("unavailable");
  const {
    version: _version,
    status: _status,
    rejectionReason: _reason,
    auditState: _audit,
    notificationState: _notification,
    ...fields
  } = a;
  void _version;
  void _status;
  void _reason;
  void _audit;
  void _notification;
  const p = checkedPending(fields);
  if (
    pendingReview(p).version !== input.originalVersion ||
    (a.status === "APPROVED" && a.rejectionReason !== null) ||
    (a.status === "REJECTED" &&
      applicationText(a.rejectionReason, 1000) !== a.rejectionReason)
  )
    throw new ReviewError("unavailable");
  return {
    originalVersion: input.originalVersion,
    actorUserId: applicationId(input.actorUserId),
    decidedAt: input.decidedAt,
    application: {
      ...p,
      version: a.version,
      status: a.status,
      rejectionReason: a.rejectionReason,
      auditState: a.auditState,
      notificationState: a.notificationState,
    },
  };
}
