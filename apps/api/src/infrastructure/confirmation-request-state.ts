import { createHash } from "node:crypto";
import type {
  ConfirmationActor,
  PendingConfirmation,
} from "../repositories/confirmation-requests.js";
import { checkedPendingConfirmation } from "../services/confirmation-requests.js";
import { DraftError } from "../services/order-drafts.js";
export function confirmationFingerprint(
  actor: ConfirmationActor,
  id: string,
  version: string,
  contact: string,
  key: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        actor.userId,
        actor.companyId,
        id,
        version,
        contact,
        key,
      ]),
    )
    .digest("hex");
}
export function pendingReplay(
  record: PendingConfirmation,
  status: string,
  integration: string,
  fingerprint: string,
) {
  const r = checkedPendingConfirmation(record);
  if (
    r.fingerprint !== fingerprint ||
    status !== "PENDING_CUSTOMER_CONFIRMATION" ||
    integration !== "NOT_SENT"
  )
    throw new DraftError("conflict");
  return r;
}
