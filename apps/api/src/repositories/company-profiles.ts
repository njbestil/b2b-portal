import type { AccountStatus } from "./common.js";
import type { LoginCredential } from "./authentication.js";
export interface CompanyProfileActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessExpiresAt: string;
  readonly companyId: string | null;
  readonly role: LoginCredential["role"];
}
export interface PortalCompanyFields {
  readonly tradeName: string;
  readonly primaryContact: string | null;
  readonly businessEmail: string | null;
  readonly phone: string | null;
  readonly billingAddress: string | null;
}
export interface FullCompanyProfile {
  readonly id: string;
  readonly version: string;
  readonly legalName: string;
  readonly status: AccountStatus;
  readonly tradeLicenseReference: string | null;
  readonly portal: PortalCompanyFields;
  readonly commercial: {
    readonly erpCustomerReference: string | null;
    readonly paymentTerms: string | null;
    readonly creditStatus: string | null;
  };
}
export interface CompanyProfileRepository {
  read(
    actor: CompanyProfileActor,
    companyId: string,
  ): Promise<FullCompanyProfile>;
  save(
    actor: CompanyProfileActor,
    companyId: string,
    version: string,
    fields: PortalCompanyFields,
  ): Promise<FullCompanyProfile>;
}
