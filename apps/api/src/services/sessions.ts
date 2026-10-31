import type { AuditInput } from "../repositories/audit.js";
import type { LoginPrincipal } from "../repositories/authentication.js";
import type {
  AccessTokens,
  SessionAdmission,
  SessionRepository,
  SessionProofs,
  VerifiedCredential,
} from "../repositories/sessions.js";
import { SessionError } from "./session-state.js";
export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly companyId: string | null;
  readonly role: LoginPrincipal["role"];
  readonly mustChangePassword: boolean;
  readonly accessExpiresAt: string;
}
export interface TokenResult {
  readonly user: LoginPrincipal;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: "Bearer";
  readonly expiresIn: number;
  readonly refreshExpiresAt: string;
}
function refreshProof(input: unknown): { id: string; token: string } {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !("refreshToken" in input) ||
    typeof input.refreshToken !== "string"
  )
    throw new SessionError("invalid_input");
  const token = input.refreshToken;
  const parts =
    /^r1\.([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/.exec(
      token,
    );
  if (!parts) throw new SessionError("invalid_proof");
  return { id: parts[1]!, token };
}
export function createSessions(
  repository: SessionRepository,
  verifyCredentials: (
    body: unknown,
    requestId: string,
  ) => Promise<{ user: LoginPrincipal; proof: VerifiedCredential }>,
  recordAudit: (input: AuditInput) => Promise<unknown>,
  config: { readonly refreshSeconds: number },
  access: AccessTokens,
  proofs: SessionProofs,
) {
  async function audit(
    admission: SessionAdmission,
    requestId: string,
    action: string,
  ) {
    try {
      await recordAudit({
        companyId: admission.user.companyId,
        actorUserId: admission.user.id,
        actorRole: admission.user.role,
        action,
        targetType: "user_session",
        targetId: admission.sessionId,
        metadata: { requestId, outcome: "success" },
      });
    } catch {
      throw new SessionError("unavailable");
    }
  }
  async function disclose(
    admission: SessionAdmission,
    token: string,
    requestId: string,
    action: string,
  ): Promise<TokenResult> {
    await audit(admission, requestId, action);
    const signed = await access.issue(
      admission.user.id,
      admission.sessionId,
      admission.expiresAt,
    );
    return {
      user: admission.user,
      accessToken: signed.token,
      refreshToken: token,
      tokenType: "Bearer",
      expiresIn: signed.expiresIn,
      refreshExpiresAt: admission.expiresAt,
    };
  }
  return {
    async login(body: unknown, requestId: string): Promise<TokenResult> {
      const { proof } = await verifyCredentials(body, requestId),
        id = proofs.newId(),
        token = proofs.refresh(id);
      const admission = await repository.create(
        proof,
        id,
        proofs.digest(token),
        config.refreshSeconds,
      );
      return disclose(admission, token, requestId, "session.issued");
    },
    async refresh(body: unknown, requestId: string): Promise<TokenResult> {
      const old = refreshProof(body),
        token = proofs.refresh(old.id);
      const admission = await repository.rotate(
        old.id,
        proofs.digest(old.token),
        proofs.digest(token),
      );
      return disclose(admission, token, requestId, "session.refreshed");
    },
    async authenticateAccess(token: string): Promise<AuthenticatedPrincipal> {
      const proof = await access.verify(token),
        admission = await repository.admit(proof.sessionId, proof.userId);
      return {
        userId: admission.user.id,
        sessionId: admission.sessionId,
        companyId: admission.user.companyId,
        role: admission.user.role,
        mustChangePassword: admission.user.mustChangePassword,
        accessExpiresAt: new Date(proof.expiresAt).toISOString(),
      };
    },
    /** Private producer capability; HTTP logout is #29. */
    async revoke(token: string, requestId: string): Promise<void> {
      const proof = await access.verify(token);
      await repository.admit(proof.sessionId, proof.userId);
      const admission = await repository.revoke(proof.sessionId, proof.userId);
      await audit(admission, requestId, "session.revoked");
    },
  };
}
export type SessionService = ReturnType<typeof createSessions>;
