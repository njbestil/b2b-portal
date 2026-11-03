import { createHash, randomUUID } from "node:crypto";
import type {
  AddressActor,
  AddressCollection,
  AddressCommand,
  DeliveryAddress,
} from "../repositories/delivery-addresses.js";
import type { LoginCredential } from "../repositories/authentication.js";
import type { SessionRecord } from "../repositories/sessions.js";
import { eligible, SessionError } from "../services/session-state.js";
import {
  AddressError,
  addressId,
  addressFields,
} from "../services/delivery-addresses.js";
import { bound } from "./session-crypto.js";
export function addressActor(
  identity: AddressActor,
  account: LoginCredential | null,
  session: SessionRecord | null,
  companyId: string,
  companyStatus: string | null,
  assigned: boolean,
  write: boolean,
  time: number,
) {
  addressId(identity.userId);
  addressId(identity.sessionId);
  addressId(companyId);
  const user = eligible(account);
  if (
    user.id !== identity.userId ||
    user.role !== identity.role ||
    user.companyId !== identity.companyId
  )
    throw new AddressError("forbidden");
  if (user.mustChangePassword) throw new SessionError("restricted");
  if (
    !Number.isFinite(Date.parse(identity.accessExpiresAt)) ||
    time >= Date.parse(identity.accessExpiresAt)
  )
    throw new SessionError("invalid_proof");
  bound(session, user, time);
  if (write && user.role !== "CUSTOMER_ADMIN")
    throw new AddressError("forbidden");
  if (user.role === "CUSTOMER_ADMIN" || user.role === "CUSTOMER_USER") {
    if (user.companyId !== companyId) throw new AddressError("not_found");
    if (companyStatus !== "ACTIVE") throw new SessionError("invalid_proof");
  }
  if (user.role === "SALES_STAFF" && (!assigned || companyStatus !== "ACTIVE"))
    throw new AddressError("forbidden");
  if (companyStatus === null) throw new AddressError("not_found");
}
export function checkedAddress(value: DeliveryAddress): DeliveryAddress {
  try {
    const fields = addressFields({
      label: value.label,
      address: value.address,
      contactName: value.contactName ?? null,
      contactPhone: value.contactPhone ?? null,
    });
    if (
      typeof value.active !== "boolean" ||
      typeof value.isDefault !== "boolean" ||
      (value.isDefault && !value.active)
    )
      throw new AddressError("unavailable");
    return {
      id: addressId(value.id),
      ...fields,
      active: value.active,
      isDefault: value.isDefault,
    };
  } catch {
    throw new AddressError("unavailable");
  }
}
export function addressCollection(
  companyId: string,
  input: DeliveryAddress[],
): AddressCollection {
  const items = input
    .map(checkedAddress)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (
    items.length > 200 ||
    new Set(items.map((r) => r.id)).size !== items.length ||
    items.filter((r) => r.isDefault).length > 1
  )
    throw new AddressError("unavailable");
  return {
    companyId,
    version:
      "addresses-" +
      createHash("sha256")
        .update(JSON.stringify({ companyId, items }))
        .digest("hex"),
    items,
  };
}
export function addressView(
  collection: AddressCollection,
  role: AddressActor["role"],
) {
  return {
    ...collection,
    items:
      role === "CUSTOMER_USER" || role === "SALES_STAFF"
        ? collection.items.filter((r) => r.active)
        : collection.items,
  };
}
export function changeAddresses(
  current: AddressCollection,
  command: AddressCommand,
) {
  if (current.version !== command.version) throw new AddressError("conflict");
  let items = current.items.map((r) => ({ ...r }));
  let affectedId: string;
  if (command.action === "create") {
    if (items.length >= 200) throw new AddressError("conflict");
    affectedId = randomUUID();
    if (command.makeDefault)
      items = items.map((r) => ({ ...r, isDefault: false }));
    items.push({
      id: affectedId,
      ...command.fields,
      active: true,
      isDefault: command.makeDefault,
    });
  } else {
    const target = items.find((r) => r.id === command.addressId);
    if (!target) throw new AddressError("not_found");
    affectedId = target.id;
    if (command.action === "update") {
      Object.assign(target, command.fields);
    } else if (command.action === "activate") {
      if (target.active) throw new AddressError("conflict");
      target.active = true;
    } else if (command.action === "set-default") {
      if (!target.active) throw new AddressError("invalid_input");
      if (target.isDefault) throw new AddressError("conflict");
      for (const row of items) row.isDefault = row.id === target.id;
    } else if (command.action === "deactivate") {
      if (!target.active) throw new AddressError("invalid_input");
      if (command.replacementId !== null) {
        const replacement = items.find((r) => r.id === command.replacementId);
        if (
          !target.isDefault ||
          !replacement ||
          !replacement.active ||
          replacement.id === target.id
        )
          throw new AddressError("invalid_input");
        replacement.isDefault = true;
      }
      target.active = false;
      target.isDefault = false;
    }
  }
  return {
    addresses: addressCollection(current.companyId, items),
    addressId: affectedId,
  };
}
