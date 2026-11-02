import type { LoginPrincipal } from "./authentication.js";
import type { VerifiedCredential } from "./sessions.js";
/** Private credential writer; HTTP never receives the snapshot/hash. */
export interface PasswordChangeRepository {
  current(
    sessionId: string,
    userId: string,
  ): Promise<{ readonly passwordHash: string }>;
  change(
    sessionId: string,
    proof: VerifiedCredential,
    newHash: string,
  ): Promise<LoginPrincipal>;
}
