import type { SalesListingActor } from "../repositories/sales-assignments.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord } from "../repositories/sessions.js";
import { eligible, SessionError } from "../services/session-state.js";
import {
  assignmentId,
  SalesAssignmentError,
} from "../services/sales-assignments.js";
import { bound } from "./session-crypto.js";
export function salesListingActor(
  identity: SalesListingActor,
  account: LoginCredential | null,
  session: SessionRecord | null,
  time: number,
) {
  assignmentId(identity.userId);
  assignmentId(identity.sessionId);
  const actor = eligible(account);
  if (actor.id !== identity.userId || actor.role !== "SALES_STAFF")
    throw new SalesAssignmentError("forbidden");
  if (actor.mustChangePassword) throw new SessionError("restricted");
  if (
    !Number.isFinite(Date.parse(identity.accessExpiresAt)) ||
    time >= Date.parse(identity.accessExpiresAt)
  )
    throw new SessionError("invalid_proof");
  bound(session, actor, time);
}
