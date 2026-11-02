import type { LoginPrincipal } from "./authentication.js";
import type { VerifiedCredential } from "./sessions.js";
export interface ResetRecord {
  id: string;
  userId: string;
  tokenHash: string;
  credentialFingerprint: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}
/** Private reset evidence. Never expose records or credential snapshots over HTTP. */
export interface PasswordResetRepository {
  ready(): Promise<boolean>;
  issue(
    email: string,
    id: string,
    digest: string,
  ): Promise<{ userId: string; expiresAt: string } | null>;
  inspect(id: string, digest: string): Promise<VerifiedCredential>;
  consume(
    id: string,
    digest: string,
    proof: VerifiedCredential,
    newHash: string,
  ): Promise<LoginPrincipal>;
}
