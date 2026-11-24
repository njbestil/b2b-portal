import {
  integrationStatuses,
  integrationErrorCodes,
  type IntegrationMonitorActor,
  type IntegrationMonitorQuery,
  type IntegrationMonitorRepository,
  type IntegrationTransactionSummary,
} from "../repositories/integration-monitor.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import { SessionError } from "./session-state.js";
export class IntegrationMonitorError extends Error {
  constructor(
    readonly code: "invalid_input" | "forbidden" | "not_found" | "unavailable",
  ) {
    super("Integration monitoring is unavailable.");
    this.name = "IntegrationMonitorError";
  }
}
export function monitorId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new IntegrationMonitorError("invalid_input");
  return value.toLowerCase();
}
function integer(
  value: unknown,
  fallback: number,
  max: number,
  min = 0,
): number {
  if (value === undefined) return fallback;
  if (typeof value === "string" && /^(?:0|[1-9]\d{0,5})$/.test(value))
    value = Number(value);
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new IntegrationMonitorError("invalid_input");
  return value;
}
export function checkedMonitorQuery(value: unknown): IntegrationMonitorQuery {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) =>
        !["offset", "limit", "status", "companyId", "orderId", "q"].includes(k),
    )
  )
    throw new IntegrationMonitorError("invalid_input");
  const input = value as Record<string, unknown>,
    offset = integer(input.offset, 0, 100000),
    limit = integer(input.limit, 20, 100, 1);
  if (
    input.status !== undefined &&
    (typeof input.status !== "string" ||
      !(integrationStatuses as readonly string[]).includes(input.status))
  )
    throw new IntegrationMonitorError("invalid_input");
  if (
    input.q !== undefined &&
    (typeof input.q !== "string" ||
      input.q.length > 128 ||
      !input.q.trim() ||
      !/^[A-Za-z0-9_ -]+$/.test(input.q))
  )
    throw new IntegrationMonitorError("invalid_input");
  return {
    offset,
    limit,
    ...(input.status === undefined
      ? {}
      : { status: input.status as IntegrationMonitorQuery["status"] }),
    ...(input.companyId === undefined
      ? {}
      : { companyId: monitorId(input.companyId) }),
    ...(input.orderId === undefined
      ? {}
      : { orderId: monitorId(input.orderId) }),
    ...(input.q === undefined ? {} : { q: (input.q as string).trim() }),
  };
}
export function monitorExpiry(
  actor: IntegrationMonitorActor,
  time: number,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new IntegrationMonitorError("unavailable");
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(Date.parse(actor.accessExpiresAt)) ||
    time >= Date.parse(actor.accessExpiresAt)
  )
    throw new SessionError("invalid_proof");
}
function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new IntegrationMonitorError("unavailable");
  return value;
}
export function checkedMonitorRecord(
  value: IntegrationTransactionSummary,
): IntegrationTransactionSummary {
  try {
    if (
      !value ||
      !(integrationStatuses as readonly string[]).includes(value.status) ||
      typeof value.retryable !== "boolean" ||
      !Number.isSafeInteger(value.retryCount) ||
      value.retryCount < 0
    )
      throw new Error();
    return {
      id: monitorId(value.id),
      companyId: monitorId(value.companyId),
      orderId: monitorId(value.orderId),
      operation:
        value.operation === "ORDER_SUBMISSION" ? "ORDER_SUBMISSION" : "OTHER",
      status: value.status,
      retryable: value.retryable,
      retryCount: value.retryCount,
      nextRetryAt:
        value.nextRetryAt === null ? null : timestamp(value.nextRetryAt),
      errorCode:
        value.errorCode === null
          ? null
          : (integrationErrorCodes as readonly string[]).includes(
                value.errorCode,
              )
            ? value.errorCode
            : "UNRECOGNIZED",
      createdAt: timestamp(value.createdAt),
      updatedAt: timestamp(value.updatedAt),
    };
  } catch {
    throw new IntegrationMonitorError("unavailable");
  }
}
export function monitorMatches(
  row: IntegrationTransactionSummary,
  query: IntegrationMonitorQuery,
): boolean {
  return (
    (!query.status || row.status === query.status) &&
    (!query.companyId || row.companyId === query.companyId) &&
    (!query.orderId || row.orderId === query.orderId) &&
    (!query.q ||
      [
        row.id,
        row.companyId,
        row.orderId,
        row.operation,
        row.status,
        row.errorCode ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(query.q.toLowerCase()))
  );
}
export function createIntegrationMonitor(
  repository: IntegrationMonitorRepository,
  now = Date.now,
) {
  function identity(
    actor: AuthorizedActor,
    signal: AbortSignal,
  ): IntegrationMonitorActor {
    requirePermission(actor, "integration-transactions.read");
    const who = {
      userId: monitorId(actor.userId),
      sessionId: monitorId(actor.sessionId),
      accessExpiresAt: actor.accessExpiresAt,
    };
    monitorExpiry(who, now(), signal);
    return who;
  }
  return {
    async list(actor: AuthorizedActor, value: unknown, signal: AbortSignal) {
      const who = identity(actor, signal),
        query = checkedMonitorQuery(value),
        result = await repository.list(who, query, signal);
      monitorExpiry(who, now(), signal);
      try {
        if (
          !result ||
          !Array.isArray(result.items) ||
          !Number.isSafeInteger(result.total) ||
          result.total < 0 ||
          result.items.length !==
            Math.min(query.limit, Math.max(result.total - query.offset, 0))
        )
          throw new Error();
        const items = result.items.map(checkedMonitorRecord);
        if (
          new Set(items.map((r) => r.id)).size !== items.length ||
          items.some(
            (r, i) =>
              !monitorMatches(r, query) ||
              // SQL retains sub-millisecond precision; projected equal milliseconds
              // do not prove a native timestamp tie. Preserve its ordering.
              (i > 0 && items[i - 1]!.createdAt < r.createdAt),
          )
        )
          throw new Error();
        return {
          items,
          total: result.total,
          offset: query.offset,
          limit: query.limit,
        };
      } catch {
        throw new IntegrationMonitorError("unavailable");
      }
    },
    async find(actor: AuthorizedActor, value: unknown, signal: AbortSignal) {
      const who = identity(actor, signal),
        id = monitorId(value),
        result = await repository.find(who, id, signal);
      monitorExpiry(who, now(), signal);
      if (result === null) throw new IntegrationMonitorError("not_found");
      const transaction = checkedMonitorRecord(result);
      if (transaction.id !== id)
        throw new IntegrationMonitorError("unavailable");
      return { transaction };
    },
  };
}
export type IntegrationMonitorService = ReturnType<
  typeof createIntegrationMonitor
>;
