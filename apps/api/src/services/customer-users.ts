import type {
  CustomerUserActor,
  CustomerUserRepository,
  ManagedCustomerUser,
  NewCustomerUser,
} from "../repositories/customer-users.js";
import type { AuditInput } from "../repositories/audit.js";
import { requirePermission, type AuthorizedActor } from "./authorization.js";
import { normalizedEmail } from "./login.js";
export class CustomerUserError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Customer user operation could not be confirmed.");
    this.name = "CustomerUserError";
  }
}
export function customerUserId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new CustomerUserError("invalid_input");
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
export function checkedNewCustomerUser(
  input: NewCustomerUser,
): NewCustomerUser {
  if (
    !input ||
    !safeText(input.displayName, 160) ||
    input.displayName !== input.displayName.trim() ||
    !safeText(input.email, 254) ||
    normalizedEmail(input.email) !== input.email ||
    !/^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(input.passwordHash)
  )
    throw new CustomerUserError("invalid_input");
  return {
    id: customerUserId(input.id),
    displayName: input.displayName,
    email: input.email,
    passwordHash: input.passwordHash,
  };
}
function identity(actor: AuthorizedActor): CustomerUserActor {
  requirePermission(actor, "customer-users.manage");
  return {
    userId: actor.userId,
    sessionId: actor.sessionId,
    companyId: customerUserId(actor.companyId),
    accessExpiresAt: actor.accessExpiresAt,
  };
}
function result(user: ManagedCustomerUser) {
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
  user: ManagedCustomerUser,
  actor: CustomerUserActor,
  id: string,
  status: "ACTIVE" | "DEACTIVATED",
) {
  if (
    !user ||
    user.id !== id ||
    user.companyId !== actor.companyId ||
    user.role !== "CUSTOMER_USER" ||
    user.status !== status ||
    typeof user.mustChangePassword !== "boolean" ||
    (status === "ACTIVE" && !user.mustChangePassword)
  )
    throw new CustomerUserError("unavailable");
  return user;
}
export function createCustomerUsers(
  repository: CustomerUserRepository,
  hash: (password: string) => Promise<string>,
  audit: (input: AuditInput) => Promise<unknown>,
  newId: () => string,
) {
  async function record(
    actor: CustomerUserActor,
    user: ManagedCustomerUser,
    action: string,
    requestId: string,
  ) {
    try {
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        actorRole: "CUSTOMER_ADMIN",
        action,
        targetType: "user",
        targetId: user.id,
        metadata: { requestId, outcome: "success" },
      });
    } catch {
      throw new CustomerUserError("unavailable");
    }
  }
  return {
    async create(actor: AuthorizedActor, value: unknown, requestId: string) {
      const who = identity(actor);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !==
          "displayName,email,temporaryPassword"
      )
        throw new CustomerUserError("invalid_input");
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
        throw new CustomerUserError("invalid_input");
      let passwordHash: string;
      try {
        passwordHash = await hash(body.temporaryPassword);
      } catch {
        throw new CustomerUserError("unavailable");
      }
      const id = customerUserId(newId());
      const user = checkedResult(
        await repository.create(
          who,
          checkedNewCustomerUser({
            id,
            displayName: body.displayName.trim(),
            email,
            passwordHash,
          }),
        ),
        who,
        id,
        "ACTIVE",
      );
      await record(who, user, "user.created", requestId);
      return result(user);
    },
    async deactivate(
      actor: AuthorizedActor,
      id: unknown,
      value: unknown,
      requestId: string,
    ) {
      const who = identity(actor);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).join(",") !== "expectedStatus" ||
        !["ACTIVE", "SUSPENDED"].includes(
          (value as Record<string, unknown>).expectedStatus as string,
        )
      )
        throw new CustomerUserError("invalid_input");
      const key = customerUserId(id);
      const user = checkedResult(
        await repository.deactivate(
          who,
          key,
          (value as { expectedStatus: "ACTIVE" | "SUSPENDED" }).expectedStatus,
        ),
        who,
        key,
        "DEACTIVATED",
      );
      await record(who, user, "user.deactivated", requestId);
      return result(user);
    },
  };
}
export type CustomerUserService = ReturnType<typeof createCustomerUsers>;
