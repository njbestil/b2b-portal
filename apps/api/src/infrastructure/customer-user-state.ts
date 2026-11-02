import type { CustomerUserActor } from "../repositories/customer-users.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord } from "../repositories/sessions.js";
import { eligible, SessionError } from "../services/session-state.js";
import {
  CustomerUserError,
  customerUserId,
} from "../services/customer-users.js";
import { bound } from "./session-crypto.js";
export function customerUserActor(
  identity: CustomerUserActor,
  account: LoginCredential | null,
  session: SessionRecord | null,
  time: number,
) {
  customerUserId(identity.userId);
  customerUserId(identity.sessionId);
  customerUserId(identity.companyId);
  const actor = eligible(account);
  if (
    actor.id !== identity.userId ||
    actor.role !== "CUSTOMER_ADMIN" ||
    actor.companyId !== identity.companyId
  )
    throw new CustomerUserError("forbidden");
  if (actor.mustChangePassword) throw new SessionError("restricted");
  if (
    !Number.isFinite(Date.parse(identity.accessExpiresAt)) ||
    time >= Date.parse(identity.accessExpiresAt)
  )
    throw new SessionError("invalid_proof");
  bound(session, actor, time);
}
