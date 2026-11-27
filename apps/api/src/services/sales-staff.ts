import type {
  SalesStaffActor,
  SalesStaffRepository,
  ManagedSalesStaff,
  NewSalesStaff,
} from "../repositories/sales-staff.js";
import type { AuditInput } from "../repositories/audit.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import { normalizedEmail } from "./login.js";
import { checkedPage } from "./query-input.js";
import type { PageRequest } from "../repositories/common.js";
export function checkedStaffPage(input?: PageRequest) {
  try {
    const p = checkedPage(input);
    if (p.offset > 100000) throw Error();
    return p;
  } catch {
    throw new SalesStaffError("invalid_input");
  }
}
export class SalesStaffError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Sales staff operation could not be confirmed.");
    this.name = "SalesStaffError";
  }
}
export function salesStaffId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new SalesStaffError("invalid_input");
  return value.toLowerCase();
}
const safeText = (value: unknown, limit: number): value is string =>
  typeof value === "string" &&
  !!value.trim() &&
  value.length <= limit &&
  !Array.from(value).some((c) => {
    const n = c.codePointAt(0)!;
    return n < 32 || (n >= 127 && n <= 159) || (n >= 0xd800 && n <= 0xdfff);
  });
export function checkedNewSalesStaff(input: NewSalesStaff): NewSalesStaff {
  if (
    !input ||
    !safeText(input.displayName, 160) ||
    input.displayName !== input.displayName.trim() ||
    !safeText(input.email, 254) ||
    normalizedEmail(input.email) !== input.email ||
    !/^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(input.passwordHash)
  )
    throw new SalesStaffError("invalid_input");
  return {
    id: salesStaffId(input.id),
    displayName: input.displayName,
    email: input.email,
    passwordHash: input.passwordHash,
  };
}
function identity(actor: AuthorizedActor): SalesStaffActor {
  requirePermission(actor, "sales-staff.manage");
  return {
    userId: actor.userId,
    sessionId: actor.sessionId,
    accessExpiresAt: actor.accessExpiresAt,
  };
}
function result(user: ManagedSalesStaff) {
  return {
    user: {
      id: user.id,
      companyId: user.companyId,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
    },
  };
}
function checkedResult(
  user: ManagedSalesStaff,
  id: string,
  status: "ACTIVE" | "DEACTIVATED",
) {
  if (
    !user ||
    user.id !== id ||
    user.companyId !== null ||
    user.role !== "SALES_STAFF" ||
    user.status !== status ||
    typeof user.mustChangePassword !== "boolean"
  )
    throw new SalesStaffError("unavailable");
  return user;
}
export function createSalesStaff(
  repository: SalesStaffRepository,
  hash: (password: string) => Promise<string>,
  audit: (input: AuditInput) => Promise<unknown>,
  newId: () => string,
) {
  async function record(
    actor: SalesStaffActor,
    user: ManagedSalesStaff,
    action: string,
    requestId: string,
  ) {
    try {
      await audit({
        companyId: null,
        actorUserId: actor.userId,
        actorRole: "INTERNAL_ADMIN",
        action,
        targetType: "user",
        targetId: user.id,
        metadata: { requestId, outcome: "success" },
      });
    } catch {
      throw new SalesStaffError("unavailable");
    }
  }
  return {
    async list(actor: AuthorizedActor, input?: PageRequest) {
      const who = identity(actor),
        page = checkedStaffPage(input),
        rows = await repository.list(who, page);
      if (
        !Number.isSafeInteger(rows.total) ||
        rows.total < 0 ||
        rows.items.length > page.limit ||
        (rows.items.length && page.offset + rows.items.length > rows.total) ||
        new Set(rows.items.map((u) => u.id)).size !== rows.items.length ||
        rows.items.some(
          (u, i) =>
            !u ||
            u.id !== salesStaffId(u.id) ||
            u.companyId !== null ||
            u.role !== "SALES_STAFF" ||
            !["ACTIVE", "SUSPENDED", "DEACTIVATED"].includes(u.status) ||
            !safeText(u.displayName, 160) ||
            (u.email !== null && !safeText(u.email, 254)) ||
            typeof u.mustChangePassword !== "boolean" ||
            (i > 0 && rows.items[i - 1]!.id >= u.id),
        )
      )
        throw new SalesStaffError("unavailable");
      return {
        items: rows.items.map((u) => result(u).user),
        total: rows.total,
        ...page,
      };
    },
    async create(actor: AuthorizedActor, value: unknown, requestId: string) {
      const who = identity(actor);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !==
          "displayName,email,temporaryPassword"
      )
        throw new SalesStaffError("invalid_input");
      const body = value as Record<string, unknown>,
        email = normalizedEmail(body.email);
      if (
        !safeText(body.displayName, 160) ||
        !safeText(body.email, 254) ||
        !email ||
        typeof body.temporaryPassword !== "string" ||
        !body.temporaryPassword.length ||
        new TextEncoder().encode(body.temporaryPassword).byteLength > 1024
      )
        throw new SalesStaffError("invalid_input");
      let passwordHash: string;
      try {
        passwordHash = await hash(body.temporaryPassword);
      } catch {
        throw new SalesStaffError("unavailable");
      }
      const id = salesStaffId(newId());
      const user = checkedResult(
        await repository.create(
          who,
          checkedNewSalesStaff({
            id,
            displayName: body.displayName.trim(),
            email,
            passwordHash,
          }),
        ),
        id,
        "ACTIVE",
      );
      if (!user.mustChangePassword) throw new SalesStaffError("unavailable");
      await record(who, user, "sales_staff.created", requestId);
      return result(user);
    },
    async change(
      actor: AuthorizedActor,
      id: unknown,
      value: unknown,
      nextStatus: "ACTIVE" | "DEACTIVATED",
      requestId: string,
    ) {
      const who = identity(actor);
      const expected = (value as { expectedStatus?: unknown } | null)
        ?.expectedStatus;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).join(",") !== "expectedStatus" ||
        !validSalesStaffTransition(expected, nextStatus)
      )
        throw new SalesStaffError("invalid_input");
      const key = salesStaffId(id);
      const user = checkedResult(
        await repository.change(
          who,
          key,
          expected as "ACTIVE" | "SUSPENDED" | "DEACTIVATED",
          nextStatus,
        ),
        key,
        nextStatus,
      );
      await record(
        who,
        user,
        nextStatus === "ACTIVE"
          ? "sales_staff.activated"
          : "sales_staff.deactivated",
        requestId,
      );
      return result(user);
    },
  };
}
export function validSalesStaffTransition(
  expected: unknown,
  next: unknown,
): boolean {
  return next === "ACTIVE"
    ? expected === "SUSPENDED" || expected === "DEACTIVATED"
    : next === "DEACTIVATED" &&
        (expected === "ACTIVE" || expected === "SUSPENDED");
}
export type SalesStaffService = ReturnType<typeof createSalesStaff>;
