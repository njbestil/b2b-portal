import type { DraftActor } from "./order-drafts.js";
export type ConfirmationActor = DraftActor & { readonly role: "SALES_STAFF" };
export interface PendingConfirmation {
  readonly id: string;
  readonly companyId: string;
  readonly orderId: string;
  readonly customerUserId: string;
  readonly status: "PENDING";
  readonly createdAt: string;
  readonly fingerprint: string;
}
export interface ConfirmationRequests {
  request(
    actor: ConfirmationActor,
    orderId: string,
    version: string,
    customerUserId: string,
    key: string,
  ): Promise<PendingConfirmation>;
  find(
    actor: ConfirmationActor,
    orderId: string,
  ): Promise<PendingConfirmation | null>;
}
