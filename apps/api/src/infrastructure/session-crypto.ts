import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord, SessionProofs } from "../repositories/sessions.js";
import { SessionError } from "../services/session-state.js";
/** Fixed domain/version, unambiguous JSON framing, exact accepted hash encoding. */
export function credentialFingerprint(userId: string, hash: string): string {
  return (
    "sha256-v1:" +
    createHash("sha256")
      .update(
        JSON.stringify([
          "b2b-session-credential-v1",
          userId.toLowerCase(),
          hash,
        ]),
      )
      .digest("hex")
  );
}

export function bound(
  record: SessionRecord | null,
  user: LoginCredential,
  now: number,
  allowRevoked = false,
): SessionRecord {
  if (
    !record ||
    record.userId !== user.id ||
    (!allowRevoked && record.revokedAt !== null) ||
    !Number.isFinite(now) ||
    now >= Date.parse(record.expiresAt) ||
    record.credentialFingerprint !==
      credentialFingerprint(user.id, user.passwordHash)
  )
    throw new SessionError("invalid_proof");
  return record;
}

export const refreshDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const sessionProofs: SessionProofs = {
  newId: randomUUID,
  refresh: (id) => "r1." + id + "." + randomBytes(32).toString("base64url"),
  digest: refreshDigest,
};
