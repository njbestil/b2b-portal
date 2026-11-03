import type { PortalCompany, PortalPage } from "./portal-reads.js";
export interface SalesCompanyPage extends PortalPage<PortalCompany> {
  readonly offset: number;
  readonly limit: number;
}
