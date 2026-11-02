import { publishJsonCredential } from "./credential-writer.js";
import * as fs from "node:fs/promises";
import type { JsonUser } from "./models.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { createJsonSessionFile, type FileIo } from "./session-file.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { bound } from "../session-crypto.js";
import {
  eligible,
  principal,
  SessionError,
  sessionId,
} from "../../services/session-state.js";
import { PasswordChangeError } from "../../services/password-change.js";
import type { PasswordChangeRepository } from "../../repositories/password-change.js";
import type { VerifiedCredential } from "../../repositories/sessions.js";

/** The injected user-file writer is an infrastructure port. Publication happens
 * before session cleanup; its failures may represent a committed credential. */
export function createJsonPasswordChange(
  security: JsonSecurityCoordinator,
  now: () => number = Date.now,
  io: FileIo = fs,
  writeUsers: (rows: readonly JsonUser[]) => Promise<void> = (rows) =>
    security.store.replace("users", rows),
): PasswordChangeRepository {
  const sessions = createJsonSessionFile(security.directory, io);
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    return security.run(async () => {
      try {
        return await operation();
      } catch (error) {
        if (
          error instanceof SessionError ||
          error instanceof PasswordChangeError
        )
          throw error;
        throw new PasswordChangeError("unavailable");
      }
    });
  }
  async function current(id: string, userId: string) {
    if (!sessionId(id) || !sessionId(userId))
      throw new SessionError("invalid_proof");
    const rows = await sessions.read(),
      user = eligible(await readJsonSecurityAccount(security, userId));
    bound(rows.find((row) => row.id === id) ?? null, user, now());
    if (!user.mustChangePassword) throw new PasswordChangeError("not_required");
    return { rows, user };
  }
  return {
    current: (id, userId) =>
      run(async () => ({
        passwordHash: (await current(id, userId)).user.passwordHash,
      })),
    change: (id, proof: VerifiedCredential, newHash) =>
      run(async () => {
        const { user } = await current(id, proof.userId);
        if (user.passwordHash !== proof.passwordHash)
          throw new SessionError("invalid_proof");
        if (
          newHash === user.passwordHash ||
          !/^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(newHash)
        )
          throw new PasswordChangeError("invalid_input");
        await publishJsonCredential(
          security,
          user,
          newHash,
          now(),
          sessions,
          writeUsers,
        );
        return principal({
          ...user,
          passwordHash: newHash,
          mustChangePassword: false,
        });
      }),
  };
}
