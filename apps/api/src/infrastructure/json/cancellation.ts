import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AuthorizedActor } from "../../services/authorization.js";
import {
  cancellationActor,
  cancellationId,
  cancellationReason,
  CancellationError,
} from "../../services/cancellation.js";
import { eligible, SessionError } from "../../services/session-state.js";
import { checkedAudit } from "../../services/audit.js";
import type { AuditRecord } from "../../repositories/audit.js";
import type {
  CancellationRequest,
  CancellationDecision,
} from "../mock-cancellation-adapter.js";
import type { CancellationStatusRepository } from "../../repositories/cancellation-status.js";
import type { JsonSecurityCoordinator } from "./security.js";
import type { JsonOrder } from "./models.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { createJsonSessionFile, type FileIo } from "./session-file.js";
import { createJsonSalesAssignmentFile } from "./sales-assignment-file.js";
import { bound } from "../session-crypto.js";
import { parseCollection } from "./schema.js";
import {
  checkedCancellationLedger,
  type CancellationEntry,
} from "./cancellation-ledger.js";
import {
  cancellationFile,
  cancellationFiles,
  publishCancellation,
} from "./cancellation-publication.js";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const text = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
async function state(security: JsonSecurityCoordinator) {
  const values = await Promise.all(
    cancellationFiles.map((n) => cancellationFile(security.directory, n)),
  );
  if (values[0] === null) throw new CancellationError("unavailable");
  const raw: unknown = JSON.parse(values[0]!),
    orders = parseCollection("orders", raw);
  if (!isDeepStrictEqual(raw, orders))
    throw new CancellationError("unavailable");
  const entries = checkedCancellationLedger(
    values[2] === null ? [] : JSON.parse(values[2]!),
  );
  const auditRaw: unknown = values[1] === null ? [] : JSON.parse(values[1]!);
  if (!Array.isArray(auditRaw)) throw new CancellationError("unavailable");
  const audits: AuditRecord[] = auditRaw.map(checkedAudit);
  if (
    !isDeepStrictEqual(auditRaw, audits) ||
    new Set(audits.map((a) => a.id)).size !== audits.length
  )
    throw new CancellationError("unavailable");
  for (const e of entries) {
    if (
      !orders.some((o) => o.id === e.orderId && o.companyId === e.companyId) ||
      e.audit.some((a) => !audits.some((r) => isDeepStrictEqual(a, r)))
    )
      throw new CancellationError("unavailable");
  }
  return {
    orders,
    entries,
    audits,
    before: Object.fromEntries(
      cancellationFiles.map((n, i) => [n, values[i]!]),
    ) as Record<(typeof cancellationFiles)[number], string | null>,
  };
}
const view = (e: CancellationEntry) => ({
  requestId: e.id,
  orderId: e.orderId,
  status: e.status,
});
export function createJsonCancellation(
  security: JsonSecurityCoordinator,
  gateway?: {
    cancel(input: CancellationRequest): Promise<CancellationDecision>;
  },
  now = Date.now,
  options: {
    io?: FileIo;
    afterPublish?: (phase: string, stage: string) => Promise<void>;
  } = {},
) {
  async function commit(
    s: Awaited<ReturnType<typeof state>>,
    orders: JsonOrder[],
    entries: CancellationEntry[],
    events: AuditRecord[],
    phase: string,
  ) {
    await publishCancellation(
      security.directory,
      s.before,
      {
        "orders.json": text(orders),
        "audit_logs.json": text([...s.audits, ...events]),
        "order_cancellations.json": text(entries),
      },
      options.io ?? fs,
      (stage) => options.afterPublish?.(phase, stage) ?? Promise.resolve(),
    );
  }
  return async function cancel(
    actor: AuthorizedActor,
    company: unknown,
    order: unknown,
    key: unknown,
    input: unknown,
  ) {
    const who = cancellationActor(actor, company),
      orderId = cancellationId(order);
    if (
      typeof key !== "string" ||
      !/^[\x21-\x7e]{1,128}$/.test(key) ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).join(",") !== "reason"
    )
      throw new CancellationError("invalid_input");
    const reason = cancellationReason((input as { reason: unknown }).reason),
      keyHash = hash(key),
      reasonHash = hash(reason);
    async function run<T>(
      work: (
        s: Awaited<ReturnType<typeof state>>,
        check: () => void,
        reference: string | null,
      ) => Promise<T>,
    ): Promise<T> {
      return security.run(async () => {
        try {
          if (
            (await cancellationFile(
              security.directory,
              "application_intent.json",
            )) !== null
          )
            throw new CancellationError("unavailable");
          const account = await readJsonSecurityAccount(security, who.userId),
            session =
              (await createJsonSessionFile(security.directory).read()).find(
                (s) => s.id === who.sessionId,
              ) ?? null;
          const companies = await security.store.read("companies"),
            target = companies.find((c) => c.id === who.companyId);
          const check = () => {
            const current = eligible(account),
              time = now();
            if (
              current.id !== who.userId ||
              current.role !== who.role ||
              current.mustChangePassword ||
              target?.status !== "ACTIVE" ||
              (who.role !== "SALES_STAFF" &&
                current.companyId !== who.companyId) ||
              !Number.isFinite(Date.parse(who.accessExpiresAt)) ||
              time >= Date.parse(who.accessExpiresAt)
            )
              throw new CancellationError("forbidden");
            bound(session, current, time);
          };
          check();
          if (who.role === "SALES_STAFF") {
            const { rows } =
                await createJsonSalesAssignmentFile(security).read(),
              active = rows.filter(
                (r) => r.companyId === who.companyId && r.active && r.isPrimary,
              );
            if (
              active.length !== 1 ||
              active[0]!.salesStaffUserId !== who.userId ||
              active[0]!.endedAt !== null ||
              Date.parse(active[0]!.createdAt) > now()
            )
              throw new CancellationError("not_found");
          }
          const s = await state(security);
          check();
          return await work(s, check, target?.erpCustomerReference ?? null);
        } catch (e) {
          if (e instanceof CancellationError || e instanceof SessionError)
            throw e;
          throw new CancellationError("unavailable");
        }
      });
    }
    function audit(action: string, id: string): AuditRecord {
      return checkedAudit({
        id: randomUUID(),
        companyId: who.companyId,
        actorUserId: who.userId,
        actorRole: who.role,
        action,
        targetType: "cancellation_request",
        targetId: id,
        metadata: { orderId, outcome: "success" },
        createdAt: new Date(now()).toISOString(),
      });
    }
    const initial = await run(async (s, check, reference) => {
      const previous = s.entries.find((e) => e.keyHash === keyHash);
      if (previous) {
        if (
          previous.companyId !== who.companyId ||
          previous.orderId !== orderId ||
          previous.userId !== who.userId ||
          previous.reasonHash !== reasonHash
        )
          throw new CancellationError("conflict");
        return view(previous);
      }
      const row = s.orders.find(
        (o) => o.companyId === who.companyId && o.id === orderId,
      );
      if (!row) throw new CancellationError("not_found");
      if (row.status === "DRAFT" && row.createdByUserId !== who.userId)
        throw new CancellationError("not_found");
      if (
        ["DELIVERED", "CANCELLED", "REJECTED"].includes(row.status) ||
        s.entries.some((e) => e.orderId === orderId && e.status === "PENDING")
      )
        throw new CancellationError("conflict");
      const direct =
        !row.erpOrderReference &&
        ["DRAFT", "PENDING_CUSTOMER_CONFIRMATION"].includes(row.status) &&
        row.integrationStatus === "NOT_SENT" &&
        !row.submittedSnapshot;
      if (
        !direct &&
        (!row.erpOrderReference ||
          !reference ||
          !["SUBMITTED", "CONFIRMED", "FULFILLING"].includes(row.status) ||
          ["PENDING", "PROCESSING", "RETRYING", "NOT_SENT"].includes(
            row.integrationStatus,
          ))
      )
        throw new CancellationError("conflict");
      if (!direct && !gateway) throw new CancellationError("unavailable");
      const id = randomUUID(),
        at = new Date(now()).toISOString(),
        events = [audit("order.cancellation_requested", id)];
      if (direct) events.push(audit("order.cancellation_completed", id));
      const entry: CancellationEntry = {
        id,
        companyId: who.companyId,
        orderId,
        userId: who.userId,
        keyHash,
        reasonHash,
        reason,
        status: direct ? "APPROVED" : "PENDING",
        createdAt: at,
        decidedAt: direct ? at : null,
        audit: events,
        attempt: direct
          ? null
          : {
              id: randomUUID(),
              status: "PENDING",
              expectedStatus: row.status,
              payload: {
                requestId: id,
                orderId,
                erpOrderId: row.erpOrderReference!,
                customerReference: reference!,
                reason,
              },
              decision: null,
            },
      };
      check();
      await commit(
        s,
        s.orders.map((o) =>
          o.id === orderId && direct
            ? {
                ...o,
                status: "CANCELLED",
                ...(o.updatedAt === undefined ? {} : { updatedAt: at }),
              }
            : o,
        ),
        [...s.entries, entry],
        events,
        "request",
      );
      return view(entry);
    });
    if (initial.status !== "PENDING") return initial;
    if (!gateway) throw new CancellationError("unavailable");
    const claimed = await run(async (s, check, reference) => {
      const e = s.entries.find((r) => r.id === initial.requestId),
        a = e?.attempt;
      if (!e || !a) throw new CancellationError("unavailable");
      if (a.status !== "PENDING") return null;
      const row = s.orders.find(
        (o) => o.id === orderId && o.companyId === who.companyId,
      );
      if (
        !row ||
        row.status !== a.expectedStatus ||
        row.erpOrderReference !== a.payload.erpOrderId ||
        reference !== a.payload.customerReference ||
        ["PENDING", "PROCESSING", "RETRYING", "NOT_SENT"].includes(
          row.integrationStatus,
        )
      )
        throw new CancellationError("conflict");
      a.status = "PROCESSING";
      check();
      await commit(s, s.orders, s.entries, [], "claim");
      return {
        request: structuredClone(a.payload),
        expectedStatus: a.expectedStatus,
      };
    });
    if (!claimed) return initial;
    let decision: CancellationDecision;
    try {
      decision = await gateway.cancel(claimed.request);
      if (
        !decision ||
        !["unknown", "approved", "rejected"].includes(decision.outcome) ||
        (decision.outcome !== "unknown" &&
          (!Number.isFinite(Date.parse(decision.decidedAt)) ||
            new Date(decision.decidedAt).toISOString() !== decision.decidedAt))
      )
        decision = { outcome: "unknown" };
    } catch {
      decision = { outcome: "unknown" };
    }
    return run(async (s, check, reference) => {
      const e = s.entries.find((r) => r.id === initial.requestId),
        a = e?.attempt,
        row = s.orders.find(
          (o) => o.id === orderId && o.companyId === who.companyId,
        );
      if (!e || !a || a.status !== "PROCESSING")
        throw new CancellationError("conflict");
      if (decision.outcome === "unknown") {
        a.status = "FAILED";
        a.decision = decision;
        check();
        await commit(s, s.orders, s.entries, [], "unknown");
        return view(e);
      }
      if (
        !row ||
        row.status !== claimed.expectedStatus ||
        row.erpOrderReference !== claimed.request.erpOrderId ||
        reference !== claimed.request.customerReference ||
        ["PENDING", "PROCESSING", "RETRYING", "NOT_SENT"].includes(
          row.integrationStatus,
        )
      )
        throw new CancellationError("conflict");
      e.status = decision.outcome === "approved" ? "APPROVED" : "REJECTED";
      e.decidedAt = decision.decidedAt;
      a.status = "SUCCESS";
      a.decision = decision;
      const event = audit("order.cancellation_decided", e.id);
      e.audit.push(event);
      check();
      await commit(
        s,
        s.orders.map((o) =>
          o.id === orderId && e.status === "APPROVED"
            ? {
                ...o,
                status: "CANCELLED",
                ...(o.updatedAt === undefined
                  ? {}
                  : { updatedAt: new Date(now()).toISOString() }),
              }
            : o,
        ),
        s.entries,
        [event],
        "decision",
      );
      return view(e);
    });
  };
}
export function createJsonCancellationStatus(
  security: JsonSecurityCoordinator,
): CancellationStatusRepository {
  return {
    latest: (companyId, orderId) =>
      security.run(async () => {
        try {
          const s = await state(security),
            row = s.orders.find(
              (r) => r.id === orderId && r.companyId === companyId,
            );
          if (!row) return null;
          const entry = s.entries
            .filter((r) => r.orderId === orderId && r.companyId === companyId)
            .sort(
              (a, b) =>
                b.createdAt.localeCompare(a.createdAt) ||
                b.id.localeCompare(a.id),
            )[0];
          return {
            createdByUserId: row.createdByUserId,
            orderStatus: row.status,
            cancellation: entry ? view(entry) : null,
          };
        } catch {
          throw new CancellationError("unavailable");
        }
      }),
  };
}
