import { createHash } from "node:crypto";
import type {
  CompanyProfileActor,
  FullCompanyProfile,
} from "../repositories/company-profiles.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord } from "../repositories/sessions.js";
import { eligible, SessionError } from "../services/session-state.js";
import {
  CompanyProfileError,
  profileId,
  profileText,
  portalCompanyFields,
} from "../services/company-profiles.js";
import { bound } from "./session-crypto.js";
export function profileActor(
  identity: CompanyProfileActor,
  account: LoginCredential | null,
  session: SessionRecord | null,
  companyId: string,
  companyStatus: string | null,
  assigned: boolean,
  write: boolean,
  time: number,
) {
  profileId(identity.userId);
  profileId(identity.sessionId);
  profileId(companyId);
  const user = eligible(account);
  if (
    user.id !== identity.userId ||
    user.role !== identity.role ||
    user.companyId !== identity.companyId
  )
    throw new CompanyProfileError("forbidden");
  if (user.mustChangePassword) throw new SessionError("restricted");
  if (
    !Number.isFinite(Date.parse(identity.accessExpiresAt)) ||
    time >= Date.parse(identity.accessExpiresAt)
  )
    throw new SessionError("invalid_proof");
  bound(session, user, time);
  if (write && user.role !== "CUSTOMER_ADMIN")
    throw new CompanyProfileError("forbidden");
  if (user.role === "CUSTOMER_ADMIN" || user.role === "CUSTOMER_USER") {
    if (user.companyId !== companyId)
      throw new CompanyProfileError("not_found");
    if (companyStatus !== "ACTIVE") throw new SessionError("invalid_proof");
  }
  if (user.role === "SALES_STAFF" && (!assigned || companyStatus !== "ACTIVE"))
    throw new CompanyProfileError("forbidden");
  if (companyStatus === null) throw new CompanyProfileError("not_found");
}
export function canonicalCompany(
  input: Omit<FullCompanyProfile, "version">,
): FullCompanyProfile {
  try {
    if (
      !["PENDING", "ACTIVE", "SUSPENDED", "REJECTED", "DEACTIVATED"].includes(
        input.status,
      )
    )
      throw new CompanyProfileError("unavailable");
    const value = {
      id: profileId(input.id),
      legalName: profileText(input.legalName, 200)!,
      status: input.status,
      tradeLicenseReference: profileText(
        input.tradeLicenseReference,
        100,
        true,
      ),
      portal: portalCompanyFields(input.portal),
      commercial: {
        erpCustomerReference: profileText(
          input.commercial.erpCustomerReference,
          200,
          true,
        ),
        paymentTerms: profileText(input.commercial.paymentTerms, 200, true),
        creditStatus: profileText(input.commercial.creditStatus, 100, true),
      },
    };
    return {
      ...value,
      version:
        "company-" +
        createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    };
  } catch {
    throw new CompanyProfileError("unavailable");
  }
}
