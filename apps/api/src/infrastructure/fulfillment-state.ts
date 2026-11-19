import type { FulfillmentActor } from "../repositories/fulfillment.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord } from "../repositories/sessions.js";
import { eligible, SessionError } from "../services/session-state.js";
import {
  FulfillmentError,
  fulfillmentId,
  fulfillmentExpiry,
} from "../services/fulfillment.js";
import { bound } from "./session-crypto.js";
export function fulfillmentActor(
  identity: FulfillmentActor,
  account: LoginCredential | null,
  session: SessionRecord | null,
  time: number,
  signal: AbortSignal,
) {
  fulfillmentId(identity.userId);
  fulfillmentId(identity.sessionId);
  const actor = eligible(account);
  if (
    actor.id !== identity.userId ||
    actor.role !== "INTERNAL_ADMIN" ||
    actor.companyId !== null
  )
    throw new FulfillmentError("forbidden");
  if (actor.mustChangePassword) throw new SessionError("restricted");
  fulfillmentExpiry(identity, time, signal);
  bound(session, actor, time);
}
