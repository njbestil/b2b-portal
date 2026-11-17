/** Private submission-time data. Callers must supply authenticated, validated
 * server-owned values under the same transaction as the submission transition. */
export interface OrderSnapshotInput {
  readonly orderId: string;
  readonly companyId: string;
  readonly submittedAt: string;
  readonly submittedBy: {
    readonly id: string;
    readonly companyId: string;
    readonly displayName: string;
    readonly role: "CUSTOMER_ADMIN" | "CUSTOMER_USER";
  };
  readonly delivery: {
    readonly id: string;
    readonly companyId: string;
    readonly label: string;
    readonly line1: string;
    readonly contactName: string | null;
    readonly contactPhone: string | null;
  };
  readonly items: readonly {
    readonly itemId: string;
    readonly productId: string;
    readonly sku: string;
    readonly name: string;
    readonly sellingUom: string;
    readonly minimumOrderQuantity: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly currency: string;
  }[];
}
export interface OrderSnapshot {
  readonly schemaVersion: 1;
  readonly orderId: string;
  readonly companyId: string;
  readonly submittedAt: string;
  readonly submittedBy: {
    readonly id: string;
    readonly displayName: string;
    readonly role: "CUSTOMER_ADMIN" | "CUSTOMER_USER";
  };
  readonly delivery: {
    readonly id: string;
    readonly label: string;
    readonly line1: string;
    readonly contactName: string | null;
    readonly contactPhone: string | null;
  };
  readonly items: readonly {
    readonly itemId: string;
    readonly productId: string;
    readonly sku: string;
    readonly name: string;
    readonly sellingUom: string;
    readonly minimumOrderQuantity: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly currency: string;
    readonly lineTotal: string;
  }[];
  readonly currency: string;
  readonly total: string;
}
