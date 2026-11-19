export interface FulfillmentResult {
  readonly orderId: string;
  readonly companyId: string;
  readonly status: "CONFIRMED" | "FULFILLING" | "DELIVERED";
  readonly changed: boolean;
}
