import type { AuditInput } from "../repositories/audit.js";
import type { PasswordResetRepository } from "../repositories/password-reset.js";
import { normalizedEmail } from "./login.js";
import { validNewPassword } from "./password-policy.js";
export class PasswordResetError extends Error {
  constructor(
    readonly code: "invalid_input" | "invalid_proof" | "unavailable",
  ) {
    super("Password reset could not be confirmed.");
    this.name = "PasswordResetError";
  }
}
interface Proofs {
  newId(): string;
  token(id: string): string;
  digest(value: string): string;
}
export type ResetDelivery = (token: string, expiresAt: string) => Promise<void>;
function shape(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",")
  )
    throw new PasswordResetError("invalid_input");
  return value as Record<string, unknown>;
}
export function createPasswordReset(
  repository: PasswordResetRepository,
  hash: (value: string) => Promise<string>,
  verify: (value: string, hash: string | null) => Promise<boolean>,
  record: (input: AuditInput) => Promise<unknown>,
  proofs: Proofs,
) {
  async function audit(
    action: string,
    requestId: string,
    userId: string | null = null,
  ) {
    try {
      await record({
        companyId: null,
        actorUserId: null,
        actorRole: null,
        action,
        targetType: "user",
        targetId: userId,
        metadata: { requestId, outcome: "success" },
      });
    } catch {
      throw new PasswordResetError("unavailable");
    }
  }
  return {
    async request(
      value: unknown,
      requestId: string,
    ): Promise<{ received: true }> {
      if (!normalizedEmail(shape(value, ["email"]).email))
        throw new PasswordResetError("invalid_input");
      // No account lookup or automatic delivery: the verified local operator
      // handles issuance separately. Identical work for all valid email inputs.
      await audit("password.reset_requested", requestId);
      return { received: true };
    },
    /** Trusted local operator capability; never mounted as a public HTTP route. */
    async issue(
      email: unknown,
      requestId: string,
      deliver: ResetDelivery,
    ): Promise<void> {
      const normalized = normalizedEmail(email);
      if (!normalized) throw new PasswordResetError("invalid_input");
      const id = proofs.newId(),
        token = proofs.token(id);
      const recipient = await repository.issue(
        normalized,
        id,
        proofs.digest(token),
      );
      if (!recipient) throw new PasswordResetError("invalid_proof");
      await audit("password.reset_issued", requestId, recipient.userId);
      try {
        await deliver(token, recipient.expiresAt);
      } catch {
        throw new PasswordResetError("unavailable");
      }
    },
    async redeem(
      value: unknown,
      requestId: string,
    ): Promise<{ requiresLogin: true }> {
      const body = shape(value, ["token", "newPassword"]),
        token = body.token;
      if (
        !validNewPassword(body.newPassword) ||
        typeof token !== "string" ||
        !/^p1\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(
          token,
        ) ||
        !/[AEIMQUYcgkosw048]$/.test(token)
      )
        throw new PasswordResetError("invalid_input");
      const id = token.split(".")[1]!,
        digest = proofs.digest(token);
      const snapshot = await repository.inspect(id, digest);
      let newHash: string;
      try {
        if (await verify(body.newPassword, snapshot.passwordHash))
          throw new PasswordResetError("invalid_input");
        newHash = await hash(body.newPassword);
      } catch (error) {
        if (error instanceof PasswordResetError) throw error;
        throw new PasswordResetError("unavailable");
      }
      const user = await repository.consume(id, digest, snapshot, newHash);
      await audit("password.reset_completed", requestId, user.id);
      return { requiresLogin: true };
    },
  };
}
export type PasswordResetService = ReturnType<typeof createPasswordReset>;
