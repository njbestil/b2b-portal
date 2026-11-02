import type { StatusActor } from "../repositories/account-status.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord } from "../repositories/sessions.js";
import { eligible, SessionError } from "../services/session-state.js";
import { AccountStatusError } from "../services/account-status.js";
import { bound } from "./session-crypto.js";
export function statusActor(
  identity: StatusActor,
  account: LoginCredential | null,
  session: SessionRecord | null,
  time: number,
) {
  const actor = eligible(account);
  if (actor.id !== identity.userId || actor.role !== "INTERNAL_ADMIN")
    throw new AccountStatusError("forbidden");
  if (actor.mustChangePassword) throw new SessionError("restricted");
  bound(session, actor, time);
}
