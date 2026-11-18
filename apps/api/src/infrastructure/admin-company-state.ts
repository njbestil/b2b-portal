import type { AdminCompanyActor } from "../repositories/admin-companies.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord } from "../repositories/sessions.js";
import { statusActor } from "./account-status-state.js";
import { SessionError } from "../services/session-state.js";
export function adminCompanyActor(
  identity: AdminCompanyActor,
  account: LoginCredential | null,
  session: SessionRecord | null,
  time: number,
) {
  statusActor(identity, account, session, time);
  if (
    !Number.isFinite(Date.parse(identity.accessExpiresAt)) ||
    time >= Date.parse(identity.accessExpiresAt)
  )
    throw new SessionError("invalid_proof");
}
