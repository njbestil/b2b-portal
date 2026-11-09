export interface DraftActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly companyId: string;
  readonly role: "CUSTOMER_ADMIN" | "CUSTOMER_USER";
  readonly accessExpiresAt: string;
}
export interface OrderDraft {
  readonly id: string;
  readonly companyId: string;
  readonly createdByUserId: string;
  readonly orderNumber: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: "DRAFT";
  readonly integrationStatus: "NOT_SENT";
  readonly deliveryAddressId: string | null;
  readonly version: string;
}
export interface DraftItem {
  readonly id: string;
  readonly productId: string;
  readonly quantity: string;
}
export interface DraftItems {
  readonly draft: OrderDraft;
  readonly items: readonly DraftItem[];
}
/** Private, server-derived provider references; never returned to the client. */
export interface DraftValidationContext {
  readonly draft: OrderDraft;
  readonly customerReference: string | null;
  readonly addressEligible: boolean;
  readonly lines: readonly (DraftItem & {
    readonly productReference: string | null;
  })[];
}
export type DraftItemChange =
  | {
      readonly kind: "add";
      readonly productId: string;
      readonly quantity: string;
    }
  | {
      readonly kind: "update";
      readonly itemId: string;
      readonly quantity: string;
    }
  | { readonly kind: "remove"; readonly itemId: string };
/** Private customer-owned draft port. No submission/ERP mutation capability. */
export interface OrderDraftRepository {
  validationContext(
    actor: DraftActor,
    id: string,
    version: string,
  ): Promise<DraftValidationContext>;
  items(actor: DraftActor, id: string): Promise<DraftItems>;
  changeItem(
    actor: DraftActor,
    id: string,
    version: string,
    change: DraftItemChange,
  ): Promise<DraftItems>;
  create(
    actor: DraftActor,
    deliveryAddressId: string | null,
  ): Promise<OrderDraft>;
  find(actor: DraftActor, id: string): Promise<OrderDraft | null>;
  update(
    actor: DraftActor,
    id: string,
    version: string,
    deliveryAddressId: string | null,
  ): Promise<OrderDraft>;
  remove(actor: DraftActor, id: string, version: string): Promise<void>;
}
