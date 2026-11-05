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
/** Private customer-owned draft port. No item/submission/ERP mutation capability. */
export interface OrderDraftRepository {
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
