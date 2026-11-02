import { OrderError } from "./orders.js";

export type FulfillmentStatus = "confirmed" | "fulfilling" | "delivered";
export interface MockErpFulfillment {
  erpOrderId: string;
  portalOrderId: string;
  customerId: string;
  fulfillmentStatus: FulfillmentStatus;
  updatedAt: string;
}
export function parseFulfillmentScenario(
  value: string | undefined,
): FulfillmentStatus {
  if (value === undefined) return "confirmed";
  if (!["confirmed", "fulfilling", "delivered"].includes(value))
    throw new OrderError(
      400,
      "INVALID_FULFILLMENT_SCENARIO",
      "Unknown Mock fulfillment scenario.",
    );
  return value as FulfillmentStatus;
}

export function parseFulfillmentReadScenario(
  value: string | undefined,
): "success" | "timeout" | "unavailable" {
  if (value === undefined) return "success";
  if (!["success", "timeout", "unavailable"].includes(value))
    throw new OrderError(
      400,
      "INVALID_FULFILLMENT_SCENARIO",
      "Unknown Mock fulfillment scenario.",
    );
  return value as "success" | "timeout" | "unavailable";
}
