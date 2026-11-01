import type { AuditInput } from "../repositories/audit.js";
import type { PasswordChangeRepository } from "../repositories/password-change.js";
import type { AuthenticatedPrincipal } from "./sessions.js";

export class PasswordChangeError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "invalid_credentials" | "not_required" | "unavailable",
  ) {
    super("Password change could not be confirmed.");
    this.name = "PasswordChangeError";
  }
}
function input(value: unknown): {
  currentPassword: string;
  newPassword: string;
} {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2
  )
    throw new PasswordChangeError("invalid_input");
  const row = value as Record<string, unknown>,
    current = row.currentPassword,
    next = row.newPassword;
  if (
    typeof current !== "string" ||
    !current.length ||
    typeof next !== "string" ||
    new TextEncoder().encode(current).byteLength > 1024 ||
    new TextEncoder().encode(next).byteLength > 1024 ||
    Array.from(next).length < 8 ||
    !/\p{Lu}/u.test(next) ||
    !/\p{N}/u.test(next) ||
    !/[\p{P}\p{S}]/u.test(next) ||
    current === next
  )
    throw new PasswordChangeError("invalid_input");
  return { currentPassword: current, newPassword: next };
}
export function createPasswordChange(
  repository: PasswordChangeRepository,
  authenticate: (token: string) => Promise<AuthenticatedPrincipal>,
  verify: (password: string, hash: string | null) => Promise<boolean>,
  hash: (password: string) => Promise<string>,
  audit: (input: AuditInput) => Promise<unknown>,
) {
  return async (
    token: string,
    value: unknown,
    requestId: string,
  ): Promise<{ requiresLogin: true }> => {
    const body = input(value),
      actor = await authenticate(token);
    if (!actor.mustChangePassword)
      throw new PasswordChangeError("not_required");
    const snapshot = await repository.current(actor.sessionId, actor.userId);
    let valid: boolean, newHash: string;
    try {
      valid = await verify(body.currentPassword, snapshot.passwordHash);
    } catch {
      throw new PasswordChangeError("unavailable");
    }
    if (!valid) {
      try {
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: "password.change_denied",
          targetType: "user",
          targetId: actor.userId,
          metadata: {
            requestId,
            outcome: "denied",
            reasonCode: "INVALID_CREDENTIALS",
          },
        });
      } catch {
        throw new PasswordChangeError("unavailable");
      }
      throw new PasswordChangeError("invalid_credentials");
    }
    try {
      newHash = await hash(body.newPassword);
    } catch {
      throw new PasswordChangeError("unavailable");
    }
    const user = await repository.change(
      actor.sessionId,
      { userId: actor.userId, passwordHash: snapshot.passwordHash },
      newHash,
    );
    try {
      await audit({
        companyId: user.companyId,
        actorUserId: user.id,
        actorRole: user.role,
        action: "password.changed",
        targetType: "user",
        targetId: user.id,
        metadata: { requestId, outcome: "success" },
      });
    } catch {
      throw new PasswordChangeError("unavailable");
    }
    return { requiresLogin: true };
  };
}
export type PasswordChangeHandler = ReturnType<typeof createPasswordChange>;
