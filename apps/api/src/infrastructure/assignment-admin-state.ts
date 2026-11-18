import type { AssignmentAdminActor } from "../repositories/admin-sales-assignments.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord } from "../repositories/sessions.js";
import { eligible, SessionError } from "../services/session-state.js";
import {
  AssignmentManagementError,
  managementId,
} from "../services/admin-sales-assignments.js";
import { bound } from "./session-crypto.js";
export function assignmentAdminActor(
  identity: AssignmentAdminActor,
  account: LoginCredential | null,
  session: SessionRecord | null,
  time: number,
) {
  managementId(identity.userId);
  managementId(identity.sessionId);
  const actor = eligible(account);
  if (
    actor.id !== identity.userId ||
    actor.role !== "INTERNAL_ADMIN" ||
    actor.companyId !== null
  )
    throw new AssignmentManagementError("forbidden");
  if (actor.mustChangePassword) throw new SessionError("restricted");
  if (
    !Number.isFinite(Date.parse(identity.accessExpiresAt)) ||
    time >= Date.parse(identity.accessExpiresAt)
  )
    throw new SessionError("invalid_proof");
  bound(session, actor, time);
}
