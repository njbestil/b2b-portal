import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ResetRecord } from "../../repositories/password-reset.js";
import type { FileIo } from "./session-file.js";
import { sessionId, tokenHash } from "../../services/session-state.js";
import { PasswordResetError } from "../../services/password-reset.js";
const fail = () => new PasswordResetError("unavailable");
const time = (v: unknown): v is string =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
function checked(input: unknown): ResetRecord[] {
  if (!Array.isArray(input) || input.length > 2000) throw fail();
  const ids = new Set(),
    hashes = new Set();
  return Array.from(input, (r: ResetRecord) => {
    if (
      !r ||
      typeof r !== "object" ||
      Array.isArray(r) ||
      Object.keys(r).some(
        (k) =>
          ![
            "id",
            "userId",
            "tokenHash",
            "credentialFingerprint",
            "createdAt",
            "expiresAt",
            "usedAt",
          ].includes(k),
      ) ||
      !sessionId(r.id) ||
      !sessionId(r.userId) ||
      !tokenHash(r.tokenHash) ||
      !(
        r.credentialFingerprint === null ||
        r.credentialFingerprint === undefined ||
        (typeof r.credentialFingerprint === "string" &&
          r.credentialFingerprint.length <= 256)
      ) ||
      !time(r.createdAt) ||
      !time(r.expiresAt) ||
      Date.parse(r.expiresAt) <= Date.parse(r.createdAt) ||
      !(r.usedAt === null || time(r.usedAt)) ||
      ids.has(r.id) ||
      hashes.has(r.tokenHash)
    )
      throw fail();
    ids.add(r.id);
    hashes.add(r.tokenHash);
    return { ...r, credentialFingerprint: r.credentialFingerprint ?? null };
  });
}
export function createJsonResetFile(directory: string, io: FileIo = fs) {
  const path = join(directory, "password_reset_tokens.json");
  return {
    async read(): Promise<ResetRecord[]> {
      try {
        const s = await io.lstat(path);
        if (!s.isFile() || s.isSymbolicLink() || s.size > 2 * 1024 * 1024)
          throw fail();
      } catch (e) {
        if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
        throw e;
      }
      return checked(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await io.readFile(path),
          ),
        ),
      );
    },
    async publish(rows: ResetRecord[]) {
      const text = JSON.stringify(checked(rows), null, 2) + "\n";
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw fail();
      const temp = join(
        directory,
        ".password_reset_tokens." + randomUUID() + ".tmp",
      );
      try {
        const h = await io.open(temp, "wx", 0o600);
        try {
          await h.writeFile(text, "utf8");
          await h.sync();
        } finally {
          await h.close();
        }
        await io.rename(temp, path);
      } finally {
        await io.unlink(temp).catch(() => {});
      }
    },
  };
}
