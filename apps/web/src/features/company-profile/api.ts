import {
  companyAccess,
  type CompanyIdentity,
  type CompanyScope,
} from "../../shared/company-scope";
import {
  RemoteError,
  createApiTransport,
  entityId,
  object,
  safeText,
  unavailable,
  type ApiTransport,
} from "../../shared/remote";
import { AuthError, type SessionClient } from "../authentication/session";
export interface PortalFields {
  tradeName: string;
  primaryContact: string | null;
  businessEmail: string | null;
  phone: string | null;
  billingAddress: string | null;
}
export interface CompanyProfile {
  id: string;
  version: string;
  legalName: string;
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "REJECTED" | "DEACTIVATED";
  tradeLicenseReference: string | null;
  portal: PortalFields;
  commercial: {
    erpCustomerReference: string | null;
    paymentTerms: string | null;
    creditStatus: string | null;
  };
}
export interface CompanyAdapter {
  read(scope: CompanyScope, signal: AbortSignal): Promise<unknown>;
  save(
    scope: CompanyScope,
    input: { version: string; fields: PortalFields },
    signal: AbortSignal,
  ): Promise<unknown>;
}
const missing: CompanyAdapter = { read: unavailable, save: unavailable };
export const profileFields = {
  tradeName: { label: "Trading name", limit: 200 },
  businessEmail: { label: "Business email", limit: 254 },
  phone: { label: "Phone", limit: 40 },
  primaryContact: { label: "Primary contact", limit: 160 },
  billingAddress: { label: "Billing address", limit: 500 },
} as const;
function nullable(value: unknown, limit: number): string | null {
  if (value == null || value === "") return null;
  if (!safeText(value, limit)) throw new RemoteError("unavailable");
  return value;
}
export function companyProfile(value: unknown): CompanyProfile {
  if (
    !object(value) ||
    !entityId(value.id) ||
    !safeText(value.version, 200) ||
    !safeText(value.legalName, 200) ||
    !["PENDING", "ACTIVE", "SUSPENDED", "REJECTED", "DEACTIVATED"].includes(
      String(value.status),
    ) ||
    !object(value.portal) ||
    !safeText(value.portal.tradeName, 200, true)
  )
    throw new RemoteError("unavailable");
  const commercial = object(value.commercial) ? value.commercial : {};
  return {
    id: value.id,
    version: value.version,
    legalName: value.legalName,
    status: value.status as CompanyProfile["status"],
    tradeLicenseReference: nullable(value.tradeLicenseReference, 100),
    portal: {
      tradeName: value.portal.tradeName,
      primaryContact: nullable(value.portal.primaryContact, 160),
      businessEmail: nullable(value.portal.businessEmail, 254),
      phone: nullable(value.portal.phone, 40),
      billingAddress: nullable(value.portal.billingAddress, 500),
    },
    commercial: {
      erpCustomerReference: nullable(commercial.erpCustomerReference, 200),
      paymentTerms: nullable(commercial.paymentTerms, 200),
      creditStatus: nullable(commercial.creditStatus, 100),
    },
  };
}
export function profileInput(value: Record<string, unknown>): PortalFields {
  if (
    Object.keys(value).length !== 5 ||
    Object.keys(value).some((key) => !(key in profileFields))
  )
    throw new RemoteError("invalid");
  if (Object.keys(profileErrors(value)).length)
    throw new RemoteError("invalid");
  const result: Record<string, string | null> = {};
  for (const [key, definition] of Object.entries(profileFields)) {
    const raw = value[key];
    if (raw !== null && typeof raw !== "string")
      throw new RemoteError("invalid");
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!safeText(text, definition.limit, key !== "tradeName"))
      throw new RemoteError("invalid");
    result[key] = text || null;
  }
  if (
    result.businessEmail &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.businessEmail)
  )
    throw new RemoteError("invalid");
  if (result.businessEmail)
    result.businessEmail = result.businessEmail.toLowerCase();
  return result as unknown as PortalFields;
}
export function profileErrors(
  value: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, definition] of Object.entries(profileFields)) {
    const raw = value[key],
      text = typeof raw === "string" ? raw.trim() : raw === null ? "" : null;
    if (text === null || !safeText(text, definition.limit, key !== "tradeName"))
      errors[key] =
        key === "tradeName" && !text
          ? "Enter a trading name."
          : `Use at most ${definition.limit} characters without control characters.`;
    else if (
      key === "businessEmail" &&
      text &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
    )
      errors[key] = "Enter a valid business email.";
  }
  return errors;
}
export class CompanyClient {
  #adapter: CompanyAdapter;
  readonly access: ReturnType<typeof companyAccess>;
  constructor(
    identity: CompanyIdentity,
    adapter: CompanyAdapter = missing,
    internalCompanyId?: string,
  ) {
    this.access = companyAccess(identity, internalCompanyId);
    this.#adapter = adapter;
  }
  #project(value: unknown) {
    const profile = companyProfile(value);
    if (profile.id.toLowerCase() !== this.access.companyId.toLowerCase())
      throw new RemoteError("unavailable");
    return profile;
  }
  canEdit(profile: CompanyProfile | null) {
    return this.access.canEdit && profile?.status === "ACTIVE";
  }
  async read(signal: AbortSignal) {
    try {
      return this.#project(await this.#adapter.read(this.access.scope, signal));
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError("unavailable");
    }
  }
  async save(
    current: CompanyProfile,
    draft: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    current = this.#project(current);
    if (!this.canEdit(current)) throw new RemoteError("forbidden");
    const fields = profileInput(draft);
    try {
      return this.#project(
        await this.#adapter.save(
          this.access.scope,
          { version: current.version, fields },
          signal,
        ),
      );
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError("unavailable");
    }
  }
}
export function companyHttpAdapter(
  transport: ApiTransport,
  routes: { own: string; internal: (companyId: string) => string },
): CompanyAdapter {
  const path = (scope: CompanyScope) =>
    scope.kind === "own" ? routes.own : routes.internal(scope.companyId);
  return {
    async read(scope, signal) {
      const data = await transport(
        { path: path(scope), method: "GET" },
        signal,
      );
      return object(data) ? data.company : undefined;
    },
    async save(scope, input, signal) {
      if (scope.kind !== "own") throw new RemoteError("forbidden");
      const data = await transport(
        {
          path: path(scope),
          method: "PATCH",
          body: { version: input.version, ...input.fields },
        },
        signal,
      );
      return object(data) ? data.company : undefined;
    },
  };
}

/** Normal session request; writes are submitted once and never replayed. */
export function authenticatedCompanyAdapter(
  session: Pick<SessionClient, "request">,
  routes: { own: string; internal: (companyId: string) => string } = {
    own: "/api/v1/company-profile",
    internal: (id) => `/api/v1/companies/${encodeURIComponent(id)}/profile`,
  },
): CompanyAdapter {
  return companyHttpAdapter(
    createApiTransport(async (path, init) => {
      try {
        const response = await session.request(path, init);
        if (response.ok && response.status !== 200)
          throw new RemoteError("unavailable");
        return response;
      } catch (error) {
        if (error instanceof AuthError)
          throw new RemoteError(
            error.code === "session" || error.code === "restricted"
              ? "session"
              : "unavailable",
          );
        throw error;
      }
    }),
    routes,
  );
}
