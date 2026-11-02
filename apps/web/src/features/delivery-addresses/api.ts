import {
  companyAccess,
  type CompanyIdentity,
  type CompanyScope,
} from "../../shared/company-scope";
import {
  RemoteError,
  entityId,
  object,
  safeText,
  unavailable,
  type ApiTransport,
} from "../../shared/remote";
export interface AddressFields {
  label: string;
  address: { line1: string };
  contactName: string | null;
  contactPhone: string | null;
}
export interface DeliveryAddress extends AddressFields {
  id: string;
  active: boolean;
  isDefault: boolean;
}
export interface AddressCollection {
  companyId: string;
  version: string;
  items: DeliveryAddress[];
}
export type AddressAction =
  | { action: "create"; fields: AddressFields; makeDefault: boolean }
  | { action: "update"; addressId: string; fields: AddressFields }
  | { action: "activate" | "set-default"; addressId: string }
  | { action: "deactivate"; addressId: string; replacementId: string | null };
export interface AddressAdapter {
  read(scope: CompanyScope, signal: AbortSignal): Promise<unknown>;
  change(
    scope: CompanyScope,
    command: AddressAction & { version: string },
    signal: AbortSignal,
  ): Promise<unknown>;
}
const missing: AddressAdapter = { read: unavailable, change: unavailable };
export const addressFields = {
  label: { label: "Address label", limit: 100, required: true },
  line1: { label: "Delivery address", limit: 500, required: true },
  contactName: { label: "Delivery contact", limit: 160, required: false },
  contactPhone: { label: "Contact phone", limit: 40, required: false },
} as const;
export function addressErrors(
  value: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, definition] of Object.entries(addressFields)) {
    const raw = value[key],
      text =
        typeof raw === "string"
          ? raw.trim()
          : raw === null && !definition.required
            ? ""
            : null;
    if (
      text === null ||
      !safeText(text, definition.limit, !definition.required)
    )
      errors[key] =
        `Enter ${definition.required ? "a nonempty value" : "a value"} of at most ${definition.limit} characters without control characters.`;
  }
  return errors;
}
export function addressInput(value: Record<string, unknown>): AddressFields {
  if (
    Object.keys(value).length !== 4 ||
    Object.keys(value).some((key) => !Object.hasOwn(addressFields, key)) ||
    Object.keys(addressErrors(value)).length
  )
    throw new RemoteError("invalid");
  return {
    label: String(value.label).trim(),
    address: { line1: String(value.line1).trim() },
    contactName:
      typeof value.contactName === "string"
        ? value.contactName.trim() || null
        : null,
    contactPhone:
      typeof value.contactPhone === "string"
        ? value.contactPhone.trim() || null
        : null,
  };
}
export function addressCollection(value: unknown): AddressCollection {
  if (
    !object(value) ||
    !entityId(value.companyId) ||
    !safeText(value.version, 200) ||
    !Array.isArray(value.items) ||
    value.items.length > 200
  )
    throw new RemoteError("unavailable");
  const items = value.items.map((item): DeliveryAddress => {
    if (
      !object(item) ||
      !entityId(item.id) ||
      !safeText(item.label, 100) ||
      !object(item.address) ||
      !safeText(item.address.line1, 500) ||
      typeof item.active !== "boolean" ||
      typeof item.isDefault !== "boolean" ||
      (item.isDefault && !item.active)
    )
      throw new RemoteError("unavailable");
    for (const [key, limit] of [
      ["contactName", 160],
      ["contactPhone", 40],
    ] as const)
      if (item[key] != null && !safeText(item[key], limit))
        throw new RemoteError("unavailable");
    return {
      id: item.id,
      label: item.label,
      address: { line1: item.address.line1 },
      active: item.active,
      isDefault: item.isDefault,
      contactName: (item.contactName as string | null | undefined) ?? null,
      contactPhone: (item.contactPhone as string | null | undefined) ?? null,
    };
  });
  if (
    new Set(items.map((item) => item.id.toLowerCase())).size !== items.length ||
    items.filter((item) => item.isDefault).length > 1
  )
    throw new RemoteError("unavailable");
  return { companyId: value.companyId, version: value.version, items };
}
export class AddressClient {
  #adapter: AddressAdapter;
  readonly access: ReturnType<typeof companyAccess>;
  readonly canInspectInactive: boolean;
  constructor(
    identity: CompanyIdentity,
    adapter: AddressAdapter = missing,
    internalCompanyId?: string,
  ) {
    this.access = companyAccess(identity, internalCompanyId);
    this.canInspectInactive =
      this.access.canEdit || identity.role === "INTERNAL_ADMIN";
    this.#adapter = adapter;
  }
  #project(value: unknown) {
    const result = addressCollection(value);
    if (result.companyId.toLowerCase() !== this.access.companyId.toLowerCase())
      throw new RemoteError("unavailable");
    return result;
  }
  #find(collection: AddressCollection, id: string) {
    if (!entityId(id)) throw new RemoteError("not-found");
    const item = collection.items.find(
      (item) => item.id.toLowerCase() === id.toLowerCase(),
    );
    if (!item) throw new RemoteError("not-found");
    return item;
  }
  async read(signal: AbortSignal) {
    try {
      return this.#project(await this.#adapter.read(this.access.scope, signal));
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError("unavailable");
    }
  }
  select(collection: AddressCollection, id: string): DeliveryAddress {
    collection = this.#project(collection);
    if (!this.access.canSelect) throw new RemoteError("forbidden");
    const item = this.#find(collection, id);
    if (!item.active) throw new RemoteError("invalid");
    return item;
  }
  async create(
    collection: AddressCollection,
    draft: Record<string, unknown>,
    makeDefault: boolean,
    signal: AbortSignal,
  ) {
    return this.#change(
      collection,
      { action: "create", fields: addressInput(draft), makeDefault },
      signal,
    );
  }
  async update(
    collection: AddressCollection,
    addressId: string,
    draft: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    return this.#change(
      collection,
      { action: "update", addressId, fields: addressInput(draft) },
      signal,
    );
  }
  async activate(
    collection: AddressCollection,
    addressId: string,
    signal: AbortSignal,
  ) {
    return this.#change(collection, { action: "activate", addressId }, signal);
  }
  async setDefault(
    collection: AddressCollection,
    addressId: string,
    signal: AbortSignal,
  ) {
    return this.#change(
      collection,
      { action: "set-default", addressId },
      signal,
    );
  }
  async deactivate(
    collection: AddressCollection,
    addressId: string,
    replacementId: string | null,
    signal: AbortSignal,
  ) {
    return this.#change(
      collection,
      { action: "deactivate", addressId, replacementId },
      signal,
    );
  }
  async #change(
    collection: AddressCollection,
    action: AddressAction,
    signal: AbortSignal,
  ): Promise<AddressCollection> {
    collection = this.#project(collection);
    if (!this.access.canEdit) throw new RemoteError("forbidden");
    const current =
      action.action === "create"
        ? null
        : this.#find(collection, action.addressId);
    if (action.action === "create" && typeof action.makeDefault !== "boolean")
      throw new RemoteError("invalid");
    if (action.action === "activate" && current?.active)
      throw new RemoteError("conflict");
    if (
      (action.action === "set-default" || action.action === "deactivate") &&
      !current?.active
    )
      throw new RemoteError("invalid");
    if (action.action === "set-default" && current?.isDefault)
      throw new RemoteError("conflict");
    if (action.action === "deactivate" && action.replacementId !== null) {
      if (
        !current?.isDefault ||
        !entityId(action.replacementId) ||
        action.replacementId.toLowerCase() === current.id.toLowerCase() ||
        !this.#find(collection, action.replacementId).active
      )
        throw new RemoteError("invalid");
    }
    try {
      const raw = await this.#adapter.change(
        this.access.scope,
        { version: collection.version, ...action },
        signal,
      );
      if (!object(raw) || !entityId(raw.addressId))
        throw new RemoteError("unavailable");
      const result = this.#project(raw.addresses),
        affected = this.#find(result, raw.addressId);
      if (
        collection.items.some(
          (old) =>
            !result.items.some(
              (item) => item.id.toLowerCase() === old.id.toLowerCase(),
            ),
        )
      )
        throw new RemoteError("unavailable");
      if (
        action.action !== "create" &&
        affected.id.toLowerCase() !== action.addressId.toLowerCase()
      )
        throw new RemoteError("unavailable");
      if (
        action.action === "create" &&
        (collection.items.some(
          (item) => item.id.toLowerCase() === affected.id.toLowerCase(),
        ) ||
          !affected.active ||
          affected.isDefault !== action.makeDefault)
      )
        throw new RemoteError("unavailable");
      if (action.action === "activate" && !affected.active)
        throw new RemoteError("unavailable");
      if (action.action === "update" && affected.active !== current?.active)
        throw new RemoteError("unavailable");
      const priorDefault =
        collection.items.find((item) => item.isDefault)?.id ?? null;
      const expectedDefault =
        action.action === "set-default" ||
        (action.action === "create" && action.makeDefault)
          ? affected.id
          : action.action === "deactivate" && current?.isDefault
            ? action.replacementId
            : priorDefault;
      const actualDefault =
        result.items.find((item) => item.isDefault)?.id ?? null;
      if (actualDefault?.toLowerCase() !== expectedDefault?.toLowerCase())
        throw new RemoteError("unavailable");
      if (
        action.action === "set-default" &&
        (!affected.active || !affected.isDefault)
      )
        throw new RemoteError("unavailable");
      if (action.action === "deactivate") {
        if (affected.active || affected.isDefault)
          throw new RemoteError("unavailable");
        if (
          current?.isDefault &&
          action.replacementId === null &&
          result.items.some((item) => item.isDefault)
        )
          throw new RemoteError("unavailable");
        if (
          action.replacementId &&
          !this.#find(result, action.replacementId).isDefault
        )
          throw new RemoteError("unavailable");
      }
      return result;
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError("unavailable");
    }
  }
}
export function addressHttpAdapter(
  transport: ApiTransport,
  routes: { own: string; internal: (companyId: string) => string },
): AddressAdapter {
  const path = (scope: CompanyScope) =>
    scope.kind === "own" ? routes.own : routes.internal(scope.companyId);
  return {
    read: (scope, signal) =>
      transport({ path: path(scope), method: "GET" }, signal),
    change: (scope, command, signal) =>
      transport({ path: path(scope), method: "POST", body: command }, signal),
  };
}
