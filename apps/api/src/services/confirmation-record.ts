import type {
  PendingConfirmation,
  StoredConfirmation,
} from "../repositories/confirmation-requests.js";
import { draftId, DraftError } from "./order-drafts.js";
export function checkedPendingConfirmation(
  value: PendingConfirmation,
): PendingConfirmation {
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "companyId,createdAt,customerUserId,fingerprint,id,orderId,status" ||
    value.status !== "PENDING" ||
    typeof value.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  )
    throw new DraftError("unavailable");
  return {
    id: draftId(value.id),
    companyId: draftId(value.companyId),
    orderId: draftId(value.orderId),
    customerUserId: draftId(value.customerUserId),
    status: "PENDING",
    createdAt: value.createdAt,
    fingerprint: value.fingerprint,
  };
}
export function rejectionReason(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1000 ||
    Array.from(value).some((c) => {
      const n = c.codePointAt(0)!;
      return (
        n < 32 ||
        n === 127 ||
        (n >= 0x80 && n <= 0x9f) ||
        (n >= 0xd800 && n <= 0xdfff)
      );
    })
  )
    throw new DraftError("invalid_input");
  return value.trim();
}
export function checkedConfirmation(
  value: StoredConfirmation,
): StoredConfirmation {
  if (value?.status === "PENDING") return checkedPendingConfirmation(value);
  if (
    !value ||
    !["CONFIRMED", "REJECTED"].includes(value.status) ||
    Object.keys(value).sort().join(",") !==
      "companyId,createdAt,customerUserId,decidedAt,decidedByUserId,fingerprint,id,orderId,reason,status"
  )
    throw new DraftError("unavailable");
  const { decidedAt, decidedByUserId, reason, ...base } = value;
  const pending = checkedPendingConfirmation({ ...base, status: "PENDING" });
  if (
    typeof decidedAt !== "string" ||
    !Number.isFinite(Date.parse(decidedAt)) ||
    new Date(decidedAt).toISOString() !== decidedAt ||
    decidedAt <= pending.createdAt ||
    (value.status === "CONFIRMED" && reason !== null) ||
    (value.status === "REJECTED" && rejectionReason(reason) !== reason)
  )
    throw new DraftError("unavailable");
  return {
    ...pending,
    status: value.status,
    decidedAt,
    decidedByUserId: draftId(decidedByUserId),
    reason,
  };
}
