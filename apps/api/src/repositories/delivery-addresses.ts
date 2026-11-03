import type { LoginCredential } from "./authentication.js";
export interface AddressActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessExpiresAt: string;
  readonly companyId: string | null;
  readonly role: LoginCredential["role"];
}
export interface AddressFields {
  readonly label: string;
  readonly address: { readonly line1: string };
  readonly contactName: string | null;
  readonly contactPhone: string | null;
}
export interface DeliveryAddress extends AddressFields {
  readonly id: string;
  readonly active: boolean;
  readonly isDefault: boolean;
}
export interface AddressCollection {
  readonly companyId: string;
  readonly version: string;
  readonly items: DeliveryAddress[];
}
export type AddressCommand = (
  | {
      readonly action: "create";
      readonly fields: AddressFields;
      readonly makeDefault: boolean;
    }
  | {
      readonly action: "update";
      readonly addressId: string;
      readonly fields: AddressFields;
    }
  | { readonly action: "activate" | "set-default"; readonly addressId: string }
  | {
      readonly action: "deactivate";
      readonly addressId: string;
      readonly replacementId: string | null;
    }
) & { readonly version: string };
export interface DeliveryAddressRepository {
  read(actor: AddressActor, companyId: string): Promise<AddressCollection>;
  change(
    actor: AddressActor,
    companyId: string,
    command: AddressCommand,
  ): Promise<{ addresses: AddressCollection; addressId: string }>;
}
