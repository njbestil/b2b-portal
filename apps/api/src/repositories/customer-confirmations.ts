import type { DraftActor } from "./order-drafts.js";
import type { StoredConfirmation } from "./confirmation-requests.js";
export type CustomerConfirmationActor = DraftActor & {
  role: "CUSTOMER_ADMIN" | "CUSTOMER_USER";
};
export type ConfirmationDecision = {
  status: "CONFIRMED" | "REJECTED";
  reason: string | null;
};
export interface ConfirmationReview {
  confirmation: StoredConfirmation;
  order: {
    id: string;
    status: string;
    createdBy: string;
    items: readonly {
      id: string;
      productId: string;
      quantity: string;
      name: string;
      sku: string;
      sellingUom: string;
    }[];
    delivery: { label: string; line1: string } | null;
  };
}
export interface CustomerConfirmations {
  find(
    actor: CustomerConfirmationActor,
    orderId: string,
  ): Promise<ConfirmationReview>;
  decide(
    actor: CustomerConfirmationActor,
    orderId: string,
    confirmationId: string,
    decision: ConfirmationDecision,
  ): Promise<ConfirmationReview>;
}
