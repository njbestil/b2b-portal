import type { ResetRecord } from "../repositories/password-reset.js";
import type { LoginCredential } from "../repositories/authentication.js";
import { PasswordResetError } from "../services/password-reset.js";
import { credentialFingerprint } from "./session-crypto.js";
export function resetBound(
  row: ResetRecord | undefined,
  user: LoginCredential,
  digest: string,
  time: number,
) {
  if (
    !row ||
    row.userId !== user.id ||
    row.tokenHash !== digest ||
    row.usedAt !== null ||
    !Number.isFinite(time) ||
    Date.parse(row.createdAt) > time ||
    Date.parse(row.expiresAt) <= time ||
    row.credentialFingerprint !==
      credentialFingerprint(user.id, user.passwordHash)
  )
    throw new PasswordResetError("invalid_proof");
  return row;
}
