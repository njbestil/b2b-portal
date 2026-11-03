import type {
  CompanyProfileRepository,
  CompanyProfileActor,
  PortalCompanyFields,
} from "../repositories/company-profiles.js";
import {
  requirePermission,
  AuthorizationError,
  type AuthorizedActor,
} from "./authorization.js";
import { normalizedEmail } from "./login.js";
export class CompanyProfileError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Company profile operation could not be confirmed.");
    this.name = "CompanyProfileError";
  }
}
export function profileId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
  )
    throw new CompanyProfileError("invalid_input");
  return value.toLowerCase();
}
export function profileText(
  value: unknown,
  limit: number,
  nullable = false,
): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (!nullable && !value.trim()) ||
    Array.from(value).some((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || n === 127 || (n >= 0xd800 && n <= 0xdfff);
    })
  )
    throw new CompanyProfileError("invalid_input");
  return value.trim() || null;
}
export function portalCompanyFields(value: unknown): PortalCompanyFields {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "billingAddress,businessEmail,phone,primaryContact,tradeName"
  )
    throw new CompanyProfileError("invalid_input");
  const row = value as Record<string, unknown>,
    businessEmail = profileText(row.businessEmail, 254, true);
  if (businessEmail !== null && !normalizedEmail(businessEmail))
    throw new CompanyProfileError("invalid_input");
  return {
    tradeName: profileText(row.tradeName, 200)!,
    primaryContact: profileText(row.primaryContact, 160, true),
    businessEmail:
      businessEmail === null ? null : normalizedEmail(businessEmail)!,
    phone: profileText(row.phone, 40, true),
    billingAddress: profileText(row.billingAddress, 500, true),
  };
}
function identity(actor: AuthorizedActor, write: boolean): CompanyProfileActor {
  requirePermission(
    actor,
    write ? "company-profile.manage" : "company-profile.read",
  );
  return {
    userId: actor.userId,
    sessionId: actor.sessionId,
    accessExpiresAt: actor.accessExpiresAt,
    companyId: actor.companyId,
    role: actor.role,
  };
}
export function createCompanyProfiles(repository: CompanyProfileRepository) {
  return {
    async own(actor: AuthorizedActor) {
      const who = identity(actor, false);
      if (
        !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(who.role) ||
        !who.companyId
      )
        throw new AuthorizationError();
      return { company: await repository.read(who, who.companyId) };
    },
    async internal(actor: AuthorizedActor, companyId: unknown) {
      const who = identity(actor, false);
      if (!["INTERNAL_ADMIN", "SALES_STAFF"].includes(who.role))
        throw new AuthorizationError();
      return { company: await repository.read(who, profileId(companyId)) };
    },
    async save(actor: AuthorizedActor, input: unknown) {
      const who = identity(actor, true);
      if (!who.companyId) throw new AuthorizationError();
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new CompanyProfileError("invalid_input");
      const { version, ...fields } = input as Record<string, unknown>;
      if (typeof version !== "string" || !/^company-[\da-f]{64}$/.test(version))
        throw new CompanyProfileError("invalid_input");
      return {
        company: await repository.save(
          who,
          who.companyId,
          version,
          portalCompanyFields(fields),
        ),
      };
    },
  };
}
export type CompanyProfileService = ReturnType<typeof createCompanyProfiles>;
