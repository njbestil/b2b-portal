import type {
  LoginCredential,
  LoginPrincipal,
} from "../repositories/authentication.js";

export class SessionError extends Error {
  constructor(
    readonly code:
      "invalid_proof" | "unavailable" | "restricted" | "invalid_input",
  ) {
    super("Authentication operation failed.");
    this.name = "SessionError";
  }
}
export const sessionId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export const tokenHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export function eligible(user: LoginCredential | null): LoginCredential {
  const customer =
    user?.role === "CUSTOMER_ADMIN" || user?.role === "CUSTOMER_USER";
  if (
    !user ||
    user.status !== "ACTIVE" ||
    (customer
      ? !user.companyId || user.companyStatus !== "ACTIVE"
      : user.companyId !== null) ||
    !/^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(user.passwordHash)
  )
    throw new SessionError("invalid_proof");
  return user;
}
export function principal(user: LoginCredential): LoginPrincipal {
  return {
    id: user.id,
    companyId: user.companyId,
    displayName: user.displayName,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}
export function requireNormalAccess(user: {
  readonly mustChangePassword: boolean;
}): void {
  if (user.mustChangePassword) throw new SessionError("restricted");
}
