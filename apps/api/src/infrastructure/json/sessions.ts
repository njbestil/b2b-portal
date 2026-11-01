import { bound, credentialFingerprint } from "../session-crypto.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
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

type FileIo = Pick<
  typeof fs,
  "lstat" | "readFile" | "open" | "rename" | "unlink"
>;
const unavailable = () => new SessionError("unavailable");
function checked(input: unknown): SessionRecord[] {
  if (!Array.isArray(input) || input.length > 10000) throw unavailable();
  const ids = new Set<string>(),
    hashes = new Set<string>();
  return Array.from(input, (value: SessionRecord) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !sessionId(value.id) ||
      !sessionId(value.userId) ||
      typeof value.refreshTokenHash !== "string" ||
      !value.refreshTokenHash.trim() ||
      value.refreshTokenHash.length > 1024 ||
      !(
        value.credentialFingerprint === null ||
        value.credentialFingerprint === undefined ||
        (typeof value.credentialFingerprint === "string" &&
          value.credentialFingerprint.length <= 256)
      ) ||
      !validTime(value.createdAt) ||
      !validTime(value.expiresAt) ||
      Date.parse(value.expiresAt) <= Date.parse(value.createdAt) ||
      !(value.revokedAt === null || validTime(value.revokedAt)) ||
      ids.has(value.id) ||
      hashes.has(value.refreshTokenHash)
    )
      throw unavailable();
    ids.add(value.id);
    hashes.add(value.refreshTokenHash);
    return {
      id: value.id,
      userId: value.userId,
      refreshTokenHash: value.refreshTokenHash,
      credentialFingerprint: value.credentialFingerprint ?? null,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      revokedAt: value.revokedAt,
    };
  });
}
function validTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export function createJsonSessions(
  security: JsonSecurityCoordinator,
  now: () => number = Date.now,
  io: FileIo = fs,
): SessionRepository {
  const path = join(security.directory, "user_sessions.json");
  async function read(): Promise<SessionRecord[]> {
    try {
      const stat = await io.lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 10 * 1024 * 1024
      )
        throw unavailable();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
    return checked(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await io.readFile(path),
        ),
      ),
    );
  }
  async function publish(rows: SessionRecord[]) {
    const text = JSON.stringify(checked(rows), null, 2) + "\n";
    if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw unavailable();
    const temporary = join(
      security.directory,
      ".user_sessions." + randomUUID() + ".tmp",
    );
    try {
      const handle = await io.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await io.rename(temporary, path);
    } finally {
      await io.unlink(temporary).catch(() => {});
    }
  }
  async function account(userId: string): Promise<LoginCredential | null> {
    const user = (await security.store.read("users")).find(
      (row) => row.id === userId,
    );
    if (
      !user ||
      user.passwordHash === undefined ||
      user.mustChangePassword === undefined
    )
      return null;
    const company =
      user.companyId === null
        ? null
        : (await security.store.read("companies")).find(
            (row) => row.id === user.companyId,
          );
    return {
      ...user,
      companyStatus: company?.status ?? null,
      passwordHash: user.passwordHash,
      mustChangePassword: user.mustChangePassword,
    };
  }
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
    const user = eligible(await account(record.userId));
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
        const user = eligible(await account(proof.userId)),
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
