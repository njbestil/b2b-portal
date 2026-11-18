import type { SalesStaffActor } from "../repositories/sales-staff.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord } from "../repositories/sessions.js";
import { eligible, SessionError } from "../services/session-state.js";
import { SalesStaffError, salesStaffId } from "../services/sales-staff.js";
import { bound } from "./session-crypto.js";
export function salesStaffActor(
  identity: SalesStaffActor,
  account: LoginCredential | null,
  session: SessionRecord | null,
  time: number,
) {
  salesStaffId(identity.userId);
  salesStaffId(identity.sessionId);
  const actor = eligible(account);
  if (
    actor.id !== identity.userId ||
    actor.role !== "INTERNAL_ADMIN" ||
    actor.companyId !== null
  )
    throw new SalesStaffError("forbidden");
  if (actor.mustChangePassword) throw new SessionError("restricted");
  if (
    !Number.isFinite(Date.parse(identity.accessExpiresAt)) ||
    time >= Date.parse(identity.accessExpiresAt)
  )
    throw new SessionError("invalid_proof");
  bound(session, actor, time);
}
