import type { LoginPrincipal } from "./authentication.js";

/** Private evidence from successful password work; never a public DTO. */
export interface VerifiedCredential {
  readonly userId: string;
  readonly passwordHash: string;
}
export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly refreshTokenHash: string;
  readonly credentialFingerprint: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}
export interface SessionAdmission {
  readonly user: LoginPrincipal;
  readonly sessionId: string;
  readonly expiresAt: string;
}
export interface AccessTokens {
  issue(
    userId: string,
    sessionId: string,
    expiresAt: string,
  ): Promise<{ token: string; expiresAt: number; expiresIn: number }>;
  verify(
    token: string,
  ): Promise<{ userId: string; sessionId: string; expiresAt: number }>;
}
export interface SessionProofs {
  newId(): string;
  refresh(sessionId: string): string;
  digest(token: string): string;
}
export interface SessionRepository {
  create(
    proof: VerifiedCredential,
    id: string,
    refreshHash: string,
    lifetimeSeconds: number,
  ): Promise<SessionAdmission>;
  admit(sessionId: string, userId: string): Promise<SessionAdmission>;
  rotate(
    sessionId: string,
    oldHash: string,
    newHash: string,
  ): Promise<SessionAdmission>;
  revoke(sessionId: string, userId: string): Promise<SessionAdmission>;
  /** Capability probe only, not provider selection or runtime fallback. */
  ready(): Promise<boolean>;
}
