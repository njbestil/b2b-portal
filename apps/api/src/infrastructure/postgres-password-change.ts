import { publishPostgresCredential } from "./postgres-credential-writer.js";
import type { Pool, PoolClient } from "pg";
import type { LoginCredential } from "../repositories/authentication.js";
import { withSecurityAccount } from "./postgres-security.js";
import { lockedSession } from "./postgres-sessions.js";
import { bound } from "./session-crypto.js";
import {
  eligible,
  principal,
  SessionError,
  sessionId,
} from "../services/session-state.js";
import { PasswordChangeError } from "../services/password-change.js";
import type { PasswordChangeRepository } from "../repositories/password-change.js";
export function createPostgresPasswordChange(
  pool: Pool,
  now: () => number = Date.now,
): PasswordChangeRepository {
  async function run<T>(
    id: string,
    userId: string,
    operation: (client: PoolClient, user: LoginCredential) => Promise<T>,
  ) {
    if (!sessionId(id) || !sessionId(userId))
      throw new SessionError("invalid_proof");
    try {
      return await withSecurityAccount(
        pool,
        userId,
        async (client, account) => {
          const user = eligible(account);
          bound(await lockedSession(client, id), user, now());
          if (!user.mustChangePassword)
            throw new PasswordChangeError("not_required");
          return operation(client, user);
        },
      );
    } catch (error) {
      if (error instanceof SessionError || error instanceof PasswordChangeError)
        throw error;
      throw new PasswordChangeError("unavailable");
    }
  }
  return {
    current: (id, userId) =>
      run(id, userId, async (_client, user) => ({
        passwordHash: user.passwordHash,
      })),
    change: (id, proof, newHash) =>
      run(id, proof.userId, async (client, account) => {
        const user = eligible(account);
        if (user.passwordHash !== proof.passwordHash)
          throw new SessionError("invalid_proof");
        if (
          newHash === user.passwordHash ||
          !/^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(newHash)
        )
          throw new PasswordChangeError("invalid_input");
        await publishPostgresCredential(client, user, newHash, now());
        return principal({
          ...user,
          passwordHash: newHash,
          mustChangePassword: false,
        });
      }),
  };
}
