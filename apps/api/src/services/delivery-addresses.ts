import type {
  AddressActor,
  AddressFields,
  AddressCommand,
  DeliveryAddressRepository,
} from "../repositories/delivery-addresses.js";
import {
  requirePermission,
  AuthorizationError,
  type AuthorizedActor,
} from "./authorization.js";
export class AddressError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Address operation could not be confirmed.");
    this.name = "AddressError";
  }
}
export function addressId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
  )
    throw new AddressError("invalid_input");
  return value.toLowerCase();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AddressError("invalid_input");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join(",") !== keys.sort().join(","))
    throw new AddressError("invalid_input");
}
export function addressText(
  value: unknown,
  limit: number,
  nullable = false,
): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > limit ||
    Array.from(value).some((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || n === 127 || (n >= 0xd800 && n <= 0xdfff);
    }) ||
    (!nullable && !value.trim())
  )
    throw new AddressError("invalid_input");
  return value.trim() || null;
}
export function addressFields(value: unknown): AddressFields {
  const row = object(value);
  exact(row, ["label", "address", "contactName", "contactPhone"]);
  const address = object(row.address);
  exact(address, ["line1"]);
  return {
    label: addressText(row.label, 100)!,
    address: { line1: addressText(address.line1, 500)! },
    contactName: addressText(row.contactName, 160, true),
    contactPhone: addressText(row.contactPhone, 40, true),
  };
}
export function addressCommand(value: unknown): AddressCommand {
  const row = object(value);
  if (
    typeof row.version !== "string" ||
    !/^addresses-[\da-f]{64}$/.test(row.version)
  )
    throw new AddressError("invalid_input");
  const version = row.version;
  if (row.action === "create") {
    exact(row, ["version", "action", "fields", "makeDefault"]);
    if (typeof row.makeDefault !== "boolean")
      throw new AddressError("invalid_input");
    return {
      version,
      action: "create",
      fields: addressFields(row.fields),
      makeDefault: row.makeDefault,
    };
  }
  if (row.action === "update") {
    exact(row, ["version", "action", "fields", "addressId"]);
    return {
      version,
      action: "update",
      addressId: addressId(row.addressId),
      fields: addressFields(row.fields),
    };
  }
  if (row.action === "activate" || row.action === "set-default") {
    exact(row, ["version", "action", "addressId"]);
    return { version, action: row.action, addressId: addressId(row.addressId) };
  }
  if (row.action === "deactivate") {
    exact(row, ["version", "action", "addressId", "replacementId"]);
    return {
      version,
      action: "deactivate",
      addressId: addressId(row.addressId),
      replacementId:
        row.replacementId === null ? null : addressId(row.replacementId),
    };
  }
  throw new AddressError("invalid_input");
}
function identity(actor: AuthorizedActor, write: boolean): AddressActor {
  requirePermission(
    actor,
    write ? "delivery-addresses.manage" : "delivery-addresses.read",
  );
  return {
    userId: actor.userId,
    sessionId: actor.sessionId,
    accessExpiresAt: actor.accessExpiresAt,
    role: actor.role,
    companyId: actor.companyId,
  };
}
export function createDeliveryAddresses(repository: DeliveryAddressRepository) {
  return {
    async own(actor: AuthorizedActor) {
      const who = identity(actor, false);
      if (
        !["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(who.role) ||
        !who.companyId
      )
        throw new AuthorizationError();
      return repository.read(who, who.companyId);
    },
    async internal(actor: AuthorizedActor, companyId: unknown) {
      const who = identity(actor, false);
      if (!["INTERNAL_ADMIN", "SALES_STAFF"].includes(who.role))
        throw new AuthorizationError();
      return repository.read(who, addressId(companyId));
    },
    async change(actor: AuthorizedActor, input: unknown) {
      const who = identity(actor, true);
      if (!who.companyId) throw new AuthorizationError();
      return repository.change(who, who.companyId, addressCommand(input));
    },
  };
}
export type DeliveryAddressService = ReturnType<typeof createDeliveryAddresses>;
