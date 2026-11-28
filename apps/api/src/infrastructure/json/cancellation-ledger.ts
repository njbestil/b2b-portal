import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { AuditRecord } from "../../repositories/audit.js";
import type {
  CancellationRequest,
  CancellationDecision,
} from "../mock-cancellation-adapter.js";
import { checkedAudit } from "../../services/audit.js";
import {
  cancellationId,
  cancellationReason,
} from "../../services/cancellation.js";
export type CancellationEntry = {
  id: string;
  companyId: string;
  orderId: string;
  userId: string;
  keyHash: string;
  reasonHash: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  decidedAt: string | null;
  audit: AuditRecord[];
  attempt: null | {
    id: string;
    status: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED";
    payload: CancellationRequest;
    expectedStatus: string;
    decision: CancellationDecision | null;
  };
};
const time = (v: unknown): v is string =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
/** Private, bounded, canonical ledger. Never pass entries or free-text reasons to HTTP. */
export function checkedCancellationLedger(input: unknown): CancellationEntry[] {
  if (!Array.isArray(input) || input.length > 5000)
    throw Error("Cancellation ledger unavailable.");
  const entries = input.map((r: CancellationEntry) => {
    if (
      !r ||
      typeof r !== "object" ||
      !hash(r.keyHash) ||
      !hash(r.reasonHash) ||
      !time(r.createdAt) ||
      !["PENDING", "APPROVED", "REJECTED"].includes(r.status) ||
      !(r.decidedAt === null || time(r.decidedAt)) ||
      (r.status === "PENDING") !== (r.decidedAt === null) ||
      !Array.isArray(r.audit) ||
      !r.audit.length ||
      r.audit.length > 2
    )
      throw Error("Cancellation ledger unavailable.");
    const row: CancellationEntry = {
      id: cancellationId(r.id),
      companyId: cancellationId(r.companyId),
      orderId: cancellationId(r.orderId),
      userId: cancellationId(r.userId),
      keyHash: r.keyHash,
      reasonHash: r.reasonHash,
      reason: cancellationReason(r.reason),
      status: r.status,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      audit: r.audit.map(checkedAudit),
      attempt: null,
    };
    if (
      createHash("sha256").update(row.reason).digest("hex") !==
        row.reasonHash ||
      (row.decidedAt !== null && row.decidedAt < row.createdAt)
    )
      throw Error("Cancellation identity unavailable.");
    if (
      row.audit[0]!.action !== "order.cancellation_requested" ||
      row.audit.some(
        (a) =>
          a.companyId !== row.companyId ||
          a.actorUserId !== row.userId ||
          a.targetType !== "cancellation_request" ||
          a.targetId !== row.id ||
          a.metadata.orderId !== row.orderId ||
          a.metadata.outcome !== "success",
      )
    )
      throw Error("Cancellation audit unavailable.");
    if (r.attempt !== null) {
      const a = r.attempt,
        p = a.payload;
      if (
        !a ||
        !p ||
        !["PENDING", "PROCESSING", "SUCCESS", "FAILED"].includes(a.status) ||
        p.requestId !== row.id ||
        p.orderId !== row.orderId ||
        p.reason !== row.reason ||
        typeof p.customerReference !== "string" ||
        !p.customerReference.trim() ||
        p.customerReference.length > 256 ||
        !["SUBMITTED", "CONFIRMED", "FULFILLING"].includes(a.expectedStatus)
      )
        throw Error("Cancellation attempt unavailable.");
      if (
        a.decision !== null &&
        (a.decision.outcome === "unknown"
          ? a.status !== "FAILED"
          : !["approved", "rejected"].includes(a.decision.outcome) ||
            !time(a.decision.decidedAt) ||
            a.status !== "SUCCESS")
      )
        throw Error("Cancellation decision unavailable.");
      if (
        a.status === "SUCCESS" &&
        (!a.decision ||
          a.decision.outcome === "unknown" ||
          row.status !==
            (a.decision.outcome === "approved" ? "APPROVED" : "REJECTED") ||
          row.decidedAt !== a.decision.decidedAt)
      )
        throw Error("Cancellation result unavailable.");
      if (a.status !== "SUCCESS" && row.status !== "PENDING")
        throw Error("Cancellation result unavailable.");
      if (
        (a.status === "FAILED" && a.decision?.outcome !== "unknown") ||
        (["PENDING", "PROCESSING"].includes(a.status) && a.decision !== null)
      )
        throw Error("Cancellation claim unavailable.");
      row.attempt = {
        id: cancellationId(a.id),
        status: a.status,
        payload: {
          requestId: row.id,
          orderId: row.orderId,
          erpOrderId: cancellationId(p.erpOrderId),
          customerReference: p.customerReference,
          reason: row.reason,
        },
        expectedStatus: a.expectedStatus,
        decision:
          a.decision === null
            ? null
            : a.decision.outcome === "unknown"
              ? { outcome: "unknown" }
              : {
                  outcome: a.decision.outcome,
                  decidedAt: a.decision.decidedAt,
                },
      };
    } else if (row.status !== "APPROVED")
      throw Error("Local cancellation unavailable.");
    if (
      row.audit.length !== (row.status === "PENDING" ? 1 : 2) ||
      (row.audit[1] &&
        row.audit[1].action !==
          (row.attempt
            ? "order.cancellation_decided"
            : "order.cancellation_completed"))
    )
      throw Error("Cancellation audit unavailable.");
    if (!isDeepStrictEqual(row, r))
      throw Error("Unsupported cancellation data.");
    return row;
  });
  for (const key of ["id", "keyHash"] as const)
    if (new Set(entries.map((r) => r[key])).size !== entries.length)
      throw Error("Duplicate cancellation identity.");
  const active = entries.filter(
    (r) => r.status === "PENDING" || r.status === "APPROVED",
  );
  if (
    new Set(active.map((r) => r.orderId)).size !== active.length ||
    new Set(entries.flatMap((r) => (r.attempt ? [r.attempt.id] : []))).size !==
      entries.filter((r) => r.attempt !== null).length
  )
    throw Error("Duplicate cancellation or attempt.");
  if (
    new Set(entries.flatMap((r) => r.audit.map((a) => a.id))).size !==
    entries.reduce((n, r) => n + r.audit.length, 0)
  )
    throw Error("Duplicate cancellation audit.");
  return entries;
}
