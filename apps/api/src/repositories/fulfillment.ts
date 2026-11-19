import type { OrderStatus } from "./orders.js";
export type FulfillmentStatus = "CONFIRMED" | "FULFILLING" | "DELIVERED";
export interface FulfillmentActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessExpiresAt: string;
}
export interface FulfillmentLink {
  readonly companyId: string;
  readonly orderId: string;
  readonly erpOrderReference: string;
  readonly customerReference: string;
  readonly status: OrderStatus;
}
/** Neutral observation: provider wire vocabulary is confined to the adapter. */
export interface FulfillmentObservation {
  readonly orderId: string;
  readonly erpOrderReference: string;
  readonly customerReference: string;
  readonly status: FulfillmentStatus;
  readonly updatedAt: string;
}
export interface FulfillmentSource {
  read(
    link: FulfillmentLink,
    signal: AbortSignal,
  ): Promise<FulfillmentObservation>;
}
export interface FulfillmentResult {
  readonly companyId: string;
  readonly orderId: string;
  readonly status: FulfillmentStatus;
  readonly changed: boolean;
}
export interface FulfillmentRepository {
  capture(
    actor: FulfillmentActor,
    companyId: string,
    orderId: string,
    signal: AbortSignal,
  ): Promise<FulfillmentLink>;
  apply(
    actor: FulfillmentActor,
    link: FulfillmentLink,
    observation: FulfillmentObservation,
    signal: AbortSignal,
  ): Promise<FulfillmentResult>;
}
