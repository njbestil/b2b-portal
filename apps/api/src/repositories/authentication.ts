import type { AuditRole } from "./audit.js";
import type { AccountStatus } from "./common.js";

/** Private backend projection; never return a credential record over HTTP. */
export interface LoginCredential {
  readonly id: string;
  readonly companyId: string | null;
  readonly displayName: string;
  readonly role: AuditRole;
  readonly status: AccountStatus;
  readonly companyStatus: AccountStatus | null;
  readonly passwordHash: string;
  readonly mustChangePassword: boolean;
}
export interface AuthenticationRepository {
  findByEmail(normalizedEmail: string): Promise<LoginCredential | null>;
}
export interface LoginPrincipal {
  readonly id: string;
  readonly companyId: string | null;
  readonly displayName: string;
  readonly role: AuditRole;
  readonly mustChangePassword: boolean;
}
