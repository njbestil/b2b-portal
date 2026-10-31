import type { AuditInput } from "../repositories/audit.js";
import type {
  AuthenticationRepository,
  LoginPrincipal,
} from "../repositories/authentication.js";

export class LoginError extends Error {
  constructor(
    readonly code: "invalid_input" | "invalid_credentials" | "unavailable",
  ) {
    super("Login failed.");
    this.name = "LoginError";
  }
}
export function normalizedEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 254) return undefined;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}
export function createLogin(
  repository: AuthenticationRepository,
  verify: (password: string, hash: string | null) => Promise<boolean>,
  record: (input: AuditInput) => Promise<unknown>,
) {
  const verifyCredentials = createVerifiedLogin(repository, verify, record);
  return async (input: unknown, requestId: string): Promise<LoginPrincipal> =>
    (await verifyCredentials(input, requestId)).user;
}
/** Private backend composition evidence. Never pass this result to HTTP. */
export function createVerifiedLogin(
  repository: AuthenticationRepository,
  verify: (password: string, hash: string | null) => Promise<boolean>,
  record: (input: AuditInput) => Promise<unknown>,
) {
  return async (input: unknown, requestId: string) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new LoginError("invalid_input");
    const body = input as Record<string, unknown>;
    const email = normalizedEmail(body.email);
    if (
      Object.keys(body).length !== 2 ||
      !email ||
      typeof body.password !== "string" ||
      !body.password.length ||
      new TextEncoder().encode(body.password).byteLength > 1024
    )
      throw new LoginError("invalid_input");
    try {
      const user = await repository.findByEmail(email);
      // Always perform the password work, including missing/disabled accounts.
      const valid = await verify(body.password, user?.passwordHash ?? null);
      const customer =
        user?.role === "CUSTOMER_ADMIN" || user?.role === "CUSTOMER_USER";
      const eligible =
        user &&
        user.status === "ACTIVE" &&
        (customer
          ? user.companyId !== null && user.companyStatus === "ACTIVE"
          : user.companyId === null);
      if (!valid || !eligible) {
        await record({
          companyId: null,
          actorUserId: null,
          actorRole: null,
          action: "login.failed",
          targetType: "user",
          targetId: null,
          metadata: {
            requestId,
            outcome: "denied",
            reasonCode: "INVALID_CREDENTIALS",
          },
        });
        throw new LoginError("invalid_credentials");
      }
      await record({
        companyId: user.companyId,
        actorUserId: user.id,
        actorRole: user.role,
        action: "login.succeeded",
        targetType: "user",
        targetId: user.id,
        metadata: { requestId, outcome: "success" },
      });
      const principal: LoginPrincipal = {
        id: user.id,
        companyId: user.companyId,
        displayName: user.displayName,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      };
      return {
        user: principal,
        proof: { userId: user.id, passwordHash: user.passwordHash },
      };
    } catch (error) {
      if (error instanceof LoginError && error.code === "invalid_credentials")
        throw error;
      throw new LoginError("unavailable");
    }
  };
}
