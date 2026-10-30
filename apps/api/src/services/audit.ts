import type {
  AuditInput,
  AuditMetadata,
  AuditRecord,
  AuditRepository,
} from "../repositories/audit.js";

export class AuditError extends Error {
  constructor(readonly code: "invalid_record" | "storage_failed") {
    super(`Audit operation failed: ${code}`);
    this.name = "AuditError";
  }
}
const invalid = (): never => {
  throw new AuditError("invalid_record");
};
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
  )
    return invalid();
  return value.toLowerCase();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function metadata(value: AuditMetadata): AuditMetadata {
  const input = object(value),
    result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (["requestId", "transactionId", "orderId"].includes(key))
      result[key] = uuid(entry);
    else if (
      key === "reasonCode" &&
      typeof entry === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(entry)
    )
      result[key] = entry;
    else if (
      key === "outcome" &&
      ["success", "failure", "denied"].includes(entry as string)
    )
      result[key] = entry;
    else if (
      key === "changedFields" &&
      Array.isArray(entry) &&
      entry.length <= 20 &&
      entry.every((field) =>
        [
          "status",
          "role",
          "companyId",
          "salesStaffUserId",
          "deliveryAddressId",
          "isDefault",
          "active",
        ].includes(field),
      )
    )
      result[key] = [...entry];
    else return invalid();
  }
  return result;
}
export function checkedAudit(record: AuditRecord): AuditRecord {
  const row = object(record);
  if (
    typeof row.action !== "string" ||
    !/^[a-z][a-z0-9_.]{0,63}$/.test(row.action) ||
    typeof row.targetType !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(row.targetType) ||
    typeof row.createdAt !== "string" ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    new Date(row.createdAt).toISOString() !== row.createdAt
  )
    return invalid();
  if (
    (row.actorUserId === null) !== (row.actorRole === null) ||
    !(
      row.actorRole === null ||
      [
        "INTERNAL_ADMIN",
        "SALES_STAFF",
        "CUSTOMER_ADMIN",
        "CUSTOMER_USER",
      ].includes(row.actorRole as string)
    )
  )
    return invalid();
  if (
    ["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(row.actorRole as string) &&
    row.companyId === null
  )
    return invalid();
  return {
    id: uuid(row.id),
    companyId: row.companyId === null ? null : uuid(row.companyId),
    actorUserId: row.actorUserId === null ? null : uuid(row.actorUserId),
    actorRole: record.actorRole,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId === null ? null : uuid(row.targetId),
    metadata: metadata(record.metadata),
    createdAt: row.createdAt,
  };
}
export function createAudit(
  repository: AuditRepository,
  newId: () => string,
  now: () => Date = () => new Date(),
) {
  return {
    record(input: AuditInput) {
      const record = checkedAudit({
        ...input,
        id: newId(),
        createdAt: now().toISOString(),
      });
      return repository.append(record);
    },
  };
}
