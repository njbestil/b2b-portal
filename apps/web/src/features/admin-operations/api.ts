import {
  AuthError,
  type SessionClient,
  type SessionUser,
} from "../authentication/session";
import {
  createApiTransport,
  entityId,
  object,
  RemoteError,
  safeText,
  timestamp,
  type ApiTransport,
  type ApiOperation,
} from "../../shared/remote";
export const accountStatuses = [
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "REJECTED",
  "DEACTIVATED",
] as const;
export type AccountStatus = (typeof accountStatuses)[number];
export const integrationStatuses = [
  "NOT_SENT",
  "PENDING",
  "PROCESSING",
  "SUCCESS",
  "FAILED",
  "RETRYING",
] as const;
const errorCodes = [
  "OUTCOME_UNKNOWN",
  "ERP_TEMPORARY_FAILURE",
  "ERP_UNAVAILABLE",
  "ERP_TIMEOUT",
  "ERP_VALIDATION_FAILED",
  "CREDIT_HOLD",
  "INSUFFICIENT_STOCK",
  "INVALID_ITEM",
  "UNRECOGNIZED",
];
export type Company = {
  id: string;
  legalName: string;
  tradeName: string;
  status: AccountStatus;
  erpCustomerReference: string | null;
};
export type Staff = {
  id: string;
  companyId: null;
  displayName: string;
  email: string | null;
  role: "SALES_STAFF";
  status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  mustChangePassword: boolean;
};
export type Assignment = {
  id: string;
  companyId: string;
  salesStaffUserId: string;
  assignedByUserId: string;
  isPrimary: true;
  active: true;
  createdAt: string;
  endedAt: null;
};
export type Transaction = {
  id: string;
  companyId: string;
  orderId: string;
  operation: "ORDER_SUBMISSION" | "OTHER";
  status: (typeof integrationStatuses)[number];
  retryable: boolean;
  retryCount: number;
  nextRetryAt: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};
export type Directory<T> = {
  items: T[];
  total: number;
  offset: number;
  limit: number;
};
export type Filters = {
  q: string;
  status: string;
  companyId: string;
  orderId: string;
};
export type Diagnostics = {
  storage: { provider: "json" | "postgresql"; status: string };
  database: { provider: "postgresql"; configured: boolean; status: string };
  erp: { provider: "mock" | null; status: string };
};
const bad = (): never => {
  throw new RemoteError("unavailable");
};
const nullableText = (v: unknown, limit = 256): v is string | null =>
  v === null || safeText(v, limit);
export function companyView(v: unknown): Company {
  if (
    !object(v) ||
    !entityId(v.id) ||
    !safeText(v.legalName, 256) ||
    !safeText(v.tradeName, 256) ||
    !accountStatuses.includes(v.status as AccountStatus) ||
    !nullableText(v.erpCustomerReference)
  )
    return bad();
  return {
    id: v.id,
    legalName: v.legalName,
    tradeName: v.tradeName,
    status: v.status as AccountStatus,
    erpCustomerReference: v.erpCustomerReference,
  };
}
export function staffView(v: unknown): Staff {
  if (
    !object(v) ||
    !entityId(v.id) ||
    v.companyId !== null ||
    v.role !== "SALES_STAFF" ||
    !safeText(v.displayName, 160) ||
    !nullableText(v.email, 254) ||
    !["ACTIVE", "SUSPENDED", "DEACTIVATED"].includes(v.status as string) ||
    typeof v.mustChangePassword !== "boolean"
  )
    return bad();
  return {
    id: v.id,
    companyId: null,
    displayName: v.displayName,
    email: v.email,
    role: "SALES_STAFF",
    status: v.status as Staff["status"],
    mustChangePassword: v.mustChangePassword,
  };
}
export function assignmentView(
  value: unknown,
  company: string,
): Assignment | null {
  if (value === null) return null;
  if (
    !object(value) ||
    !entityId(value.id) ||
    value.companyId !== company ||
    !entityId(value.salesStaffUserId) ||
    !entityId(value.assignedByUserId) ||
    value.isPrimary !== true ||
    value.active !== true ||
    value.endedAt !== null ||
    !timestamp(value.createdAt)
  )
    return bad();
  return {
    id: value.id,
    companyId: company,
    salesStaffUserId: value.salesStaffUserId,
    assignedByUserId: value.assignedByUserId,
    isPrimary: true,
    active: true,
    createdAt: value.createdAt,
    endedAt: null,
  };
}
export function transactionView(v: unknown): Transaction {
  if (
    !object(v) ||
    !entityId(v.id) ||
    !entityId(v.companyId) ||
    !entityId(v.orderId) ||
    !["ORDER_SUBMISSION", "OTHER"].includes(v.operation as string) ||
    !integrationStatuses.includes(v.status as Transaction["status"]) ||
    typeof v.retryable !== "boolean" ||
    !Number.isSafeInteger(v.retryCount) ||
    (v.retryCount as number) < 0 ||
    (v.retryCount as number) > 2147483647 ||
    !(v.nextRetryAt === null || timestamp(v.nextRetryAt)) ||
    !(v.errorCode === null || errorCodes.includes(v.errorCode as string)) ||
    !timestamp(v.createdAt) ||
    !timestamp(v.updatedAt)
  )
    return bad();
  return {
    id: v.id,
    companyId: v.companyId,
    orderId: v.orderId,
    operation: v.operation as Transaction["operation"],
    status: v.status as Transaction["status"],
    retryable: v.retryable,
    retryCount: v.retryCount as number,
    nextRetryAt: v.nextRetryAt,
    errorCode: v.errorCode as string | null,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}
export function diagnosticsView(v: unknown): Diagnostics {
  const states = ["up", "down", "timeout", "unconfigured"];
  if (
    !object(v) ||
    !object(v.storage) ||
    !object(v.database) ||
    !object(v.erp) ||
    !["json", "postgresql"].includes(v.storage.provider as string) ||
    !states.includes(v.storage.status as string) ||
    v.database.provider !== "postgresql" ||
    typeof v.database.configured !== "boolean" ||
    !["up", "down", "timeout", "not_in_use"].includes(
      v.database.status as string,
    ) ||
    !(v.erp.provider === null || v.erp.provider === "mock") ||
    !states.includes(v.erp.status as string) ||
    (v.storage.provider === "json" && v.database.status !== "not_in_use") ||
    (v.storage.provider === "postgresql" &&
      (!v.database.configured || v.database.status === "not_in_use")) ||
    (v.erp.provider === null && v.erp.status !== "unconfigured")
  )
    return bad();
  return {
    storage: {
      provider: v.storage.provider as Diagnostics["storage"]["provider"],
      status: v.storage.status as string,
    },
    database: {
      provider: "postgresql",
      configured: v.database.configured,
      status: v.database.status as string,
    },
    erp: {
      provider: v.erp.provider as "mock" | null,
      status: v.erp.status as string,
    },
  };
}
export function monitorQuery(filters: Filters, offset: number) {
  pageOffset(offset);
  const p = new URLSearchParams({ offset: String(offset), limit: "20" });
  if (filters.q) {
    if (
      filters.q.length > 128 ||
      !filters.q.trim() ||
      !/^[A-Za-z0-9_ -]+$/.test(filters.q)
    )
      throw new RemoteError("invalid");
    p.set("q", filters.q);
  }
  if (filters.status) {
    if (!integrationStatuses.includes(filters.status as Transaction["status"]))
      throw new RemoteError("invalid");
    p.set("status", filters.status);
  }
  for (const k of ["companyId", "orderId"] as const) {
    if (filters[k]) {
      if (!entityId(filters[k])) throw new RemoteError("invalid");
      p.set(k, filters[k]);
    }
  }
  return p.toString();
}
function pageOffset(n: number) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 100000)
    throw new RemoteError("invalid");
}
function pageView<T extends { id: string }>(
  v: unknown,
  offset: number,
  project: (v: unknown) => T,
): Directory<T> {
  if (
    !object(v) ||
    !Array.isArray(v.items) ||
    v.offset !== offset ||
    v.limit !== 20 ||
    v.items.length > 20 ||
    !Number.isSafeInteger(v.total) ||
    (v.total as number) < 0 ||
    (v.items.length && offset + v.items.length > (v.total as number))
  )
    return bad();
  const items = v.items.map(project);
  if (new Set(items.map((i) => i.id)).size !== items.length) return bad();
  return { items, total: v.total as number, offset, limit: 20 };
}
const id = (v: string) => {
  if (!entityId(v)) throw new RemoteError("invalid");
  return v;
};
export class AdminClient {
  private readonly send: ApiTransport;
  constructor(session: SessionClient, user: SessionUser) {
    if (
      user.mustChangePassword ||
      user.role !== "INTERNAL_ADMIN" ||
      user.companyId !== null
    )
      throw new RemoteError("forbidden");
    this.send = createApiTransport(async (path, init) => {
      try {
        return await session.request(path, init);
      } catch (e) {
        throw new RemoteError(
          e instanceof AuthError && ["session", "restricted"].includes(e.code)
            ? "session"
            : "unavailable",
        );
      }
    });
  }
  private call(
    path: string,
    signal: AbortSignal,
    method: ApiOperation["method"] = "GET",
    body?: unknown,
  ) {
    return this.send(
      { path, method, ...(body === undefined ? {} : { body }) },
      signal,
    );
  }
  async companies(offset: number, s: AbortSignal) {
    pageOffset(offset);
    return pageView(
      await this.call(`/api/v1/admin/companies?offset=${offset}&limit=20`, s),
      offset,
      companyView,
    );
  }
  async company(key: string, s: AbortSignal) {
    const body = await this.call(`/api/v1/companies/${id(key)}`, s);
    if (!object(body)) return bad();
    const c = companyView(body.company);
    if (c.id !== key) return bad();
    return c;
  }
  async staff(offset: number, s: AbortSignal) {
    pageOffset(offset);
    return pageView(
      await this.call(`/api/v1/admin/sales-staff?offset=${offset}&limit=20`, s),
      offset,
      staffView,
    );
  }
  async createStaff(
    body: { displayName: string; email: string; temporaryPassword: string },
    s: AbortSignal,
  ) {
    if (
      !safeText(body.displayName, 160) ||
      !safeText(body.email, 254) ||
      !body.temporaryPassword.length ||
      new TextEncoder().encode(body.temporaryPassword).byteLength > 1024
    )
      throw new RemoteError("invalid");
    const v = await this.call("/api/v1/admin/sales-staff", s, "POST", body);
    if (!object(v)) return bad();
    const u = staffView(v.user);
    if (u.status !== "ACTIVE" || !u.mustChangePassword) return bad();
    return u;
  }
  async status(kind: "companies" | "users", key: string, s: AbortSignal) {
    const v = await this.call(`/api/v1/admin/${kind}/${id(key)}/status`, s);
    return this.statusView(v, kind, key);
  }
  private statusView(
    v: unknown,
    kind: "companies" | "users",
    key: string,
  ): AccountStatus {
    if (
      !object(v) ||
      !object(v.target) ||
      v.target.id !== key ||
      v.target.kind !== (kind === "companies" ? "company" : "user") ||
      !accountStatuses.includes(v.target.status as AccountStatus)
    )
      return bad();
    return v.target.status as AccountStatus;
  }
  async changeCompany(
    key: string,
    expected: AccountStatus,
    next: "ACTIVE" | "SUSPENDED",
    s: AbortSignal,
  ) {
    if (!(
      (expected === "ACTIVE" && next === "SUSPENDED") ||
      (expected === "SUSPENDED" && next === "ACTIVE")
    ))
      throw new RemoteError("invalid");
    const status = this.statusView(
      await this.call(`/api/v1/admin/companies/${id(key)}/status`, s, "PATCH", {
        expectedStatus: expected,
        status: next,
      }),
      "companies",
      key,
    );
    if (status !== next) return bad();
    return status;
  }
  async changeStaff(
    key: string,
    expected: AccountStatus,
    next: "ACTIVE" | "DEACTIVATED",
    s: AbortSignal,
  ) {
    if (
      !["ACTIVE", "SUSPENDED", "DEACTIVATED"].includes(expected) ||
      (next === "ACTIVE" ? expected === "ACTIVE" : expected === "DEACTIVATED")
    )
      throw new RemoteError("invalid");
    const v = await this.call(
      `/api/v1/admin/sales-staff/${id(key)}/${next === "ACTIVE" ? "activate" : "deactivate"}`,
      s,
      "POST",
      { expectedStatus: expected },
    );
    if (!object(v)) return bad();
    const user = staffView(v.user);
    if (user.id !== key || user.status !== next) return bad();
    return user;
  }
  async assignment(company: string, s: AbortSignal) {
    const v = await this.call(
      `/api/v1/admin/companies/${id(company)}/sales-assignment`,
      s,
    );
    if (!object(v)) return bad();
    return assignmentView(v.assignment, company);
  }
  async assign(
    company: string,
    staff: string,
    expected: string | null,
    s: AbortSignal,
  ) {
    if (expected !== null) id(expected);
    const v = await this.call(
      `/api/v1/admin/companies/${id(company)}/sales-assignment`,
      s,
      "PUT",
      { salesStaffUserId: id(staff), expectedAssignmentId: expected },
    );
    if (!object(v)) return bad();
    const a = assignmentView(v.assignment, company);
    if (!a || a.salesStaffUserId !== staff || a.id === expected) return bad();
    return a;
  }
  async transactions(filters: Filters, offset: number, s: AbortSignal) {
    return pageView(
      await this.call(
        `/api/v1/admin/integration-transactions?${monitorQuery(filters, offset)}`,
        s,
      ),
      offset,
      transactionView,
    );
  }
  async transaction(key: string, s: AbortSignal) {
    const v = await this.call(
      `/api/v1/admin/integration-transactions/${id(key)}`,
      s,
    );
    if (!object(v)) return bad();
    const row = transactionView(v.transaction);
    if (row.id !== key) return bad();
    return row;
  }
  async retry(row: Transaction, s: AbortSignal) {
    if (!canRequestRetry(row)) throw new RemoteError("invalid");
    const v = await this.call(
      `/api/v1/admin/integration-transactions/${id(row.id)}/retry`,
      s,
      "POST",
      { retryCount: row.retryCount, updatedAt: row.updatedAt },
    );
    if (!object(v) || v.transactionId !== row.id) return bad();
  }
  async diagnostics(s: AbortSignal) {
    return diagnosticsView(await this.call("/api/v1/admin/diagnostics", s));
  }
}
export const canRequestRetry = (row: Transaction) =>
  row.operation === "ORDER_SUBMISSION" &&
  row.status === "FAILED" &&
  row.retryable &&
  row.errorCode !== null &&
  ["ERP_TEMPORARY_FAILURE", "ERP_UNAVAILABLE", "ERP_TIMEOUT"].includes(
    row.errorCode,
  );
