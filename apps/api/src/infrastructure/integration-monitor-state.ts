import type { IntegrationMonitorActor } from "../repositories/integration-monitor.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord } from "../repositories/sessions.js";
import { eligible, SessionError } from "../services/session-state.js";
import {
  IntegrationMonitorError,
  monitorId,
  monitorExpiry,
} from "../services/integration-monitor.js";
import { bound } from "./session-crypto.js";
export function integrationMonitorActor(
  identity: IntegrationMonitorActor,
  account: LoginCredential | null,
  session: SessionRecord | null,
  time: number,
  signal: AbortSignal,
) {
  monitorId(identity.userId);
  monitorId(identity.sessionId);
  const user = eligible(account);
  if (
    user.id !== identity.userId ||
    user.role !== "INTERNAL_ADMIN" ||
    user.companyId !== null
  )
    throw new IntegrationMonitorError("forbidden");
  if (user.mustChangePassword) throw new SessionError("restricted");
  monitorExpiry(identity, time, signal);
  bound(session, user, time);
}
