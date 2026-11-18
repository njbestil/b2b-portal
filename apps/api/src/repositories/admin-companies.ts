import type { Page, PageRequest } from "./common.js";
import type { CompanyProfile } from "./companies.js";
export interface AdminCompanyActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessExpiresAt: string;
}
/** Private authenticated directory port; no lifecycle writes. */
export interface AdminCompanyRepository {
  list(
    actor: AdminCompanyActor,
    page: PageRequest,
  ): Promise<Page<CompanyProfile>>;
}
