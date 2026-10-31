import type {
  ApplicationFields,
  ApplicationRecord,
  ApplicationRepository,
} from "../repositories/applications.js";
import type { AuditInput } from "../repositories/audit.js";
import { normalizedEmail } from "./login.js";

export class ApplicationError extends Error {
  constructor(readonly code: "invalid_input" | "unavailable") {
    super("Application operation failed.");
    this.name = "ApplicationError";
  }
}
const invalid = (): never => {
  throw new ApplicationError("invalid_input");
};
export function applicationText(value: unknown, limit: number): string {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    !value.trim() ||
    Array.from(value).some((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || n === 127 || (n >= 0xd800 && n <= 0xdfff);
    })
  )
    return invalid();
  return value.trim();
}
export function applicationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
  )
    return invalid();
  return value.toLowerCase();
}
export const licenseKey = (value: string) =>
  applicationText(applicationText(value, 100).toUpperCase(), 100);
export function applicationFields(input: unknown): ApplicationFields {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return invalid();
  const b = input as Record<string, unknown>;
  const email = (v: unknown) => normalizedEmail(v) ?? invalid();
  return {
    companyName: applicationText(b.companyName, 200),
    tradeLicenseReference: licenseKey(
      applicationText(b.tradeLicenseReference, 100),
    ),
    businessEmail: email(b.businessEmail),
    phone: applicationText(b.phone, 40),
    billingAddress: applicationText(b.billingAddress, 500),
    deliveryAddress: applicationText(b.deliveryAddress, 500),
    administratorName: applicationText(b.administratorName, 160),
    administratorEmail: email(b.administratorEmail),
    administratorMobile: applicationText(b.administratorMobile, 40),
  };
}
export function checkedApplication(
  input: ApplicationRecord,
): ApplicationRecord {
  const fields = applicationFields(input);
  if (
    typeof input.passwordHash !== "string" ||
    !/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(input.passwordHash) ||
    typeof input.createdAt !== "string" ||
    !/^[0-9]{4}-/.test(input.createdAt) ||
    input.createdAt.startsWith("0000-") ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    new Date(input.createdAt).toISOString() !== input.createdAt
  )
    return invalid();
  return {
    ...fields,
    companyId: applicationId(input.companyId),
    administratorUserId: applicationId(input.administratorUserId),
    deliveryAddressId: applicationId(input.deliveryAddressId),
    passwordHash: input.passwordHash,
    createdAt: input.createdAt,
  };
}
export function pendingProjection(record: ApplicationRecord) {
  return {
    ...applicationFields(record),
    companyId: record.companyId,
    administratorUserId: record.administratorUserId,
    deliveryAddressId: record.deliveryAddressId,
    createdAt: record.createdAt,
  };
}
export function checkedPending(input: unknown) {
  const fields = applicationFields(input),
    r = input as Record<string, unknown>;
  const keys = [
    ...Object.keys(fields),
    "companyId",
    "administratorUserId",
    "deliveryAddressId",
    "createdAt",
  ];
  if (
    Object.keys(r).length !== keys.length ||
    Object.keys(r).some((k) => !keys.includes(k))
  )
    return invalid();
  if (
    typeof r.createdAt !== "string" ||
    !Number.isFinite(Date.parse(r.createdAt)) ||
    new Date(r.createdAt).toISOString() !== r.createdAt
  )
    return invalid();
  return {
    ...fields,
    companyId: applicationId(r.companyId),
    administratorUserId: applicationId(r.administratorUserId),
    deliveryAddressId: applicationId(r.deliveryAddressId),
    createdAt: r.createdAt,
  };
}
export function createApplications(
  repository: ApplicationRepository,
  hash: (password: string) => Promise<string>,
  audit: (event: AuditInput) => Promise<unknown>,
  newId: () => string,
  now: () => Date = () => new Date(),
) {
  let active = 0;
  return async (input: unknown, requestId: string) => {
    const fields = applicationFields(input);
    const row = input as Record<string, unknown>;
    if (
      Object.keys(row).length !== Object.keys(fields).length + 1 ||
      Object.keys(row).some(
        (key) => ![...Object.keys(fields), "password"].includes(key),
      ) ||
      typeof row.password !== "string" ||
      !row.password.length ||
      Buffer.byteLength(row.password, "utf8") > 1024 ||
      Array.from(row.password).some((c) => {
        const n = c.codePointAt(0)!;
        return n >= 0xd800 && n <= 0xdfff;
      })
    )
      return invalid();
    if (active >= 16) throw new ApplicationError("unavailable");
    active++;
    try {
      const passwordHash = await hash(row.password);
      const record = checkedApplication({
        ...fields,
        passwordHash,
        companyId: newId(),
        administratorUserId: newId(),
        deliveryAddressId: newId(),
        createdAt: now().toISOString(),
      });
      const result = await repository.submit(record);
      await audit({
        companyId: result.companyId,
        actorUserId: null,
        actorRole: null,
        action: "application.received",
        targetType: "company",
        targetId: result.companyId,
        metadata: { requestId, outcome: "success" },
      });
      return { state: "received" as const, reference: requestId };
    } catch {
      throw new ApplicationError("unavailable");
    } finally {
      active--;
    }
  };
}
