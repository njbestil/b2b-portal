import { createHash } from "node:crypto";
import type { OrderSummary } from "../repositories/orders.js";
import type { OrderDraft, DraftActor } from "../repositories/order-drafts.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord } from "../repositories/sessions.js";
import { eligible, SessionError } from "../services/session-state.js";
import { DraftError, draftId } from "../services/order-drafts.js";
import { bound } from "./session-crypto.js";
export function draftActor(
  identity: DraftActor,
  account: LoginCredential | null,
  session: SessionRecord | null,
  time: number,
) {
  draftId(identity.userId);
  draftId(identity.sessionId);
  draftId(identity.companyId);
  const user = eligible(account);
  if (
    user.id !== identity.userId ||
    user.role !== identity.role ||
    user.companyId !== identity.companyId ||
    !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(user.role)
  )
    throw new DraftError("forbidden");
  if (user.mustChangePassword) throw new SessionError("restricted");
  if (
    !Number.isFinite(Date.parse(identity.accessExpiresAt)) ||
    time >= Date.parse(identity.accessExpiresAt)
  )
    throw new SessionError("invalid_proof");
  bound(session, user, time);
}
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
export function canonicalDraft(
  row: OrderSummary & { deliveryAddressId: string | null; updatedAt: string },
): OrderDraft {
  try {
    if (
      row.status !== "DRAFT" ||
      row.integrationStatus !== "NOT_SENT" ||
      !timestamp(row.createdAt) ||
      !timestamp(row.updatedAt) ||
      row.updatedAt < row.createdAt ||
      !(
        row.orderNumber === null ||
        (typeof row.orderNumber === "string" &&
          !!row.orderNumber.trim() &&
          row.orderNumber.length <= 200 &&
          !Array.from(row.orderNumber).some((c) => {
            const n = c.codePointAt(0)!;
            return n < 32 || n === 127 || (n >= 0xd800 && n <= 0xdfff);
          }))
      )
    )
      throw new Error();
    const value = {
      id: draftId(row.id),
      companyId: draftId(row.companyId),
      createdByUserId: draftId(row.createdByUserId),
      orderNumber: row.orderNumber,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      status: "DRAFT" as const,
      integrationStatus: "NOT_SENT" as const,
      deliveryAddressId:
        row.deliveryAddressId === null ? null : draftId(row.deliveryAddressId),
    };
    return {
      ...value,
      version:
        "draft-" +
        createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    };
  } catch {
    throw new DraftError("unavailable");
  }
}
export function nextDraftTime(previous: string, time: number) {
  if (!Number.isFinite(time) || !timestamp(previous))
    throw new DraftError("unavailable");
  return new Date(Math.max(time, Date.parse(previous) + 1)).toISOString();
}
