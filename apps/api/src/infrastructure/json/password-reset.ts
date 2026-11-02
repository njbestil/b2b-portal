import * as fs from "node:fs/promises";
import type { PasswordResetRepository } from "../../repositories/password-reset.js";
import type { JsonSecurityCoordinator } from "./security.js";
import { createJsonResetFile } from "./reset-file.js";
import { createJsonSessionFile, type FileIo } from "./session-file.js";
import { readJsonSecurityAccount } from "./security-account.js";
import {
  eligible,
  principal,
  SessionError,
  sessionId,
  tokenHash,
} from "../../services/session-state.js";
import { PasswordResetError } from "../../services/password-reset.js";
import { credentialFingerprint } from "../session-crypto.js";
import { resetBound } from "../reset-state.js";
import { publishJsonCredential } from "./credential-writer.js";
import type { JsonUser } from "./models.js";
export function createJsonPasswordReset(
  security: JsonSecurityCoordinator,
  now = Date.now,
  io: FileIo = fs,
  writeUsers: (rows: readonly JsonUser[]) => Promise<void> = (rows) =>
    security.store.replace("users", rows),
): PasswordResetRepository {
  const tokens = createJsonResetFile(security.directory, io),
    sessions = createJsonSessionFile(security.directory, io);
  const run = <T>(op: () => Promise<T>) =>
    security.run(async () => {
      try {
        return await op();
      } catch (e) {
        if (e instanceof PasswordResetError) throw e;
        if (e instanceof SessionError && e.code === "invalid_proof")
          throw new PasswordResetError("invalid_proof");
        throw new PasswordResetError("unavailable");
      }
    });
  async function current(id: string, digest: string) {
    if (!sessionId(id) || !tokenHash(digest))
      throw new PasswordResetError("invalid_proof");
    const rows = await tokens.read(),
      row = rows.find((r) => r.id === id);
    if (!row) throw new PasswordResetError("invalid_proof");
    const user = eligible(await readJsonSecurityAccount(security, row.userId));
    resetBound(row, user, digest, now());
    return { rows, row, user };
  }
  return {
    ready: () =>
      run(async () => {
        await tokens.read();
        await security.store.read("users");
        await security.store.read("companies");
        return true;
      }).catch(() => false),
    issue: (email, id, digest) =>
      run(async () => {
        if (!sessionId(id) || !tokenHash(digest))
          throw new PasswordResetError("invalid_input");
        const found = (await security.store.read("users")).find(
          (u) => u.email === email,
        );
        if (!found) return null;
        let user;
        try {
          user = eligible(await readJsonSecurityAccount(security, found.id));
        } catch (e) {
          if (e instanceof SessionError && e.code === "invalid_proof")
            return null;
          throw e;
        }
        const time = now(),
          rows = (await tokens.read()).filter(
            (r) =>
              r.usedAt === null &&
              Date.parse(r.expiresAt) > time &&
              r.userId !== user.id,
          );
        if (!Number.isFinite(time) || rows.length >= 2000)
          throw new PasswordResetError("unavailable");
        const expiresAt = new Date(time + 1800000).toISOString();
        rows.push({
          id,
          userId: user.id,
          tokenHash: digest,
          credentialFingerprint: credentialFingerprint(
            user.id,
            user.passwordHash,
          ),
          createdAt: new Date(time).toISOString(),
          expiresAt,
          usedAt: null,
        });
        await tokens.publish(rows);
        return { userId: user.id, expiresAt };
      }),
    inspect: (id, digest) =>
      run(async () => {
        const { user } = await current(id, digest);
        return { userId: user.id, passwordHash: user.passwordHash };
      }),
    consume: (id, digest, proof, newHash) =>
      run(async () => {
        const { rows, row, user } = await current(id, digest);
        if (
          user.id !== proof.userId ||
          user.passwordHash !== proof.passwordHash
        )
          throw new PasswordResetError("invalid_proof");
        await publishJsonCredential(
          security,
          user,
          newHash,
          now(),
          sessions,
          writeUsers,
        );
        row.usedAt = new Date(now()).toISOString();
        await tokens.publish(rows);
        return principal({
          ...user,
          passwordHash: newHash,
          mustChangePassword: false,
        });
      }),
  };
}
