import type { AccountStatus, CompanyScope, EntityId } from "./common.js";

/** A read projection, not the complete persistence schema or an API DTO. */
export interface CompanyProfile {
  readonly id: EntityId;
  readonly legalName: string;
  readonly tradeName: string;
  readonly status: AccountStatus;
  readonly erpCustomerReference: string | null;
}

export interface CompanyRepository {
  findById(scope: CompanyScope): Promise<CompanyProfile | null>;
}
