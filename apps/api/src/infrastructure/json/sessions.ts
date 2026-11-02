import { createJsonSessionFile, type FileIo } from "./session-file.js";
import { readJsonSecurityAccount } from "./security-account.js";
import { bound, credentialFingerprint } from "../session-crypto.js";
import * as fs from "node:fs/promises";
import type { LoginCredential } from "../../repositories/authentication.js";
import type {
  SessionRecord,
  SessionRepository,
} from "../../repositories/sessions.js";
import {
  SessionError,
  eligible,
  principal,
  sessionId,
  tokenHash,
} from "../../services/session-state.js";
import type { JsonSecurityCoordinator } from "./security.js";
const unavailable = () => new SessionError("unavailable");

export function createJsonSessions(
  security: JsonSecurityCoordinator,
  now: () => number = Date.now,
  io: FileIo = fs,
): SessionRepository {
  const { read, publish } = createJsonSessionFile(security.directory, io);
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    return security.run(async () => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof SessionError) throw error;
        throw unavailable();
      }
    });
  }
  const admission = (record: SessionRecord, user: LoginCredential) => ({
    user: principal(user),
    sessionId: record.id,
    expiresAt: record.expiresAt,
  });
  async function existing(id: string, userId?: string, allowRevoked = false) {
    if (!sessionId(id) || (userId !== undefined && !sessionId(userId)))
      throw new SessionError("invalid_proof");
    const rows = await read(),
      record = rows.find((row) => row.id === id) ?? null;
    if (!record || (userId !== undefined && record.userId !== userId))
      throw new SessionError("invalid_proof");
    const user = eligible(
      await readJsonSecurityAccount(security, record.userId),
    );
    // Sample only after the queue and required reads.
    bound(record, user, now(), allowRevoked);
    return { rows, record, user };
  }
  return {
    create: (proof, id, refreshHash, lifetime) =>
      run(async () => {
        if (
          !sessionId(proof.userId) ||
          !sessionId(id) ||
          !tokenHash(refreshHash) ||
          !Number.isInteger(lifetime) ||
          lifetime < 1 ||
          lifetime > 604800
        )
          throw unavailable();
        const user = eligible(
            await readJsonSecurityAccount(security, proof.userId),
          ),
          rows = await read();
        if (user.passwordHash !== proof.passwordHash)
          throw new SessionError("invalid_proof");
        const time = now();
        if (!Number.isFinite(time)) throw unavailable();
        const record: SessionRecord = {
          id,
          userId: user.id,
          refreshTokenHash: refreshHash,
          credentialFingerprint: credentialFingerprint(
            user.id,
            proof.passwordHash,
          ),
          createdAt: new Date(time).toISOString(),
          expiresAt: new Date(time + lifetime * 1000).toISOString(),
          revokedAt: null,
        };
        rows.push(record);
        await publish(rows);
        return admission(record, user);
      }),
    admit: (id, userId) =>
      run(async () => {
        const { record, user } = await existing(id, userId);
        return admission(record, user);
      }),
    rotate: (id, oldHash, newHash) =>
      run(async () => {
        if (!tokenHash(oldHash) || !tokenHash(newHash))
          throw new SessionError("invalid_proof");
        const { rows, record, user } = await existing(id);
        if (record.refreshTokenHash !== oldHash)
          throw new SessionError("invalid_proof");
        rows[rows.indexOf(record)] = { ...record, refreshTokenHash: newHash };
        await publish(rows);
        return admission(record, user);
      }),
    revoke: (id, userId) =>
      run(async () => {
        const { rows, record, user } = await existing(id, userId, true);
        if (record.revokedAt === null) {
          rows[rows.indexOf(record)] = {
            ...record,
            revokedAt: new Date(now()).toISOString(),
          };
          await publish(rows);
        }
        return admission(record, user);
      }),
    ready: () =>
      run(async () => {
        await read();
        await security.store.read("users");
        await security.store.read("companies");
        return true;
      }).catch(() => false),
  };
}
