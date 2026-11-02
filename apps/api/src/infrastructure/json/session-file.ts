import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecord } from "../../repositories/sessions.js";
import { SessionError, sessionId } from "../../services/session-state.js";
export type FileIo = Pick<
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
export function createJsonSessionFile(directory: string, io: FileIo = fs) {
  const path = join(directory, "user_sessions.json");
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
      directory,
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
  return { read, publish };
}
