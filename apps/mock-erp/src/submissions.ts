import { createHash } from "node:crypto";
import { createMasterData } from "./master-data.js";
import { createOrderService, OrderError } from "./orders.js";

type OrderService = ReturnType<typeof createOrderService>;
type Snapshot = { sku: string; name: string };
interface Submission {
  externalRequestReference: string;
  portalOrderId: string;
  customerId: string;
  items: {
    productId: string;
    quantity: string;
    sellingUom: string;
    unitPrice: string;
    currency: string;
    snapshot: Snapshot;
  }[];
}
export type SubmissionScenario =
  | "success"
  | "validation"
  | "credit-hold"
  | "insufficient-stock"
  | "invalid-item";
type Receipt = {
  externalRequestReference: string;
  portalOrderId: string;
  customerId: string;
} & (
  | {
      outcome: "accepted" | "existing-order";
      order: ReturnType<OrderService["findById"]> & {
        items: Submission["items"];
      };
    }
  | { outcome: "rejected"; rejection: { code: string; message: string } }
);

function invalid(): never {
  throw new OrderError(
    400,
    "INVALID_SUBMISSION",
    "Invalid Mock submission request.",
  );
}
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 128): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) &&
    value.trim() === value
  );
}
function parse(input: unknown): Submission {
  const body = fields(input, [
    "externalRequestReference",
    "portalOrderId",
    "customerId",
    "items",
  ]);
  const seed = createMasterData();
  if (
    typeof body.externalRequestReference !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
      body.externalRequestReference,
    ) ||
    typeof body.portalOrderId !== "string" ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(body.portalOrderId) ||
    typeof body.customerId !== "string" ||
    !seed.customers.some(
      (row) => row.customerId === body.customerId && row.active,
    ) ||
    !Array.isArray(body.items) ||
    body.items.length < 1 ||
    body.items.length > 100
  )
    return invalid();
  const seen = new Set<string>();
  const items = Array.from(body.items, (value: unknown) => {
    const item = fields(value, [
      "productId",
      "quantity",
      "sellingUom",
      "unitPrice",
      "currency",
      "snapshot",
    ]);
    const snapshot = fields(item.snapshot, ["sku", "name"]);
    if (
      typeof item.productId !== "string" ||
      !seed.products.some(
        (row) => row.productId === item.productId && row.active,
      ) ||
      seen.has(item.productId) ||
      typeof item.quantity !== "string" ||
      !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(item.quantity) ||
      !/[1-9]/.test(item.quantity) ||
      typeof item.unitPrice !== "string" ||
      !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(item.unitPrice) ||
      typeof item.sellingUom !== "string" ||
      !["Piece", "Pack", "Carton", "Case", "Bag", "KG"].includes(
        item.sellingUom,
      ) ||
      typeof item.currency !== "string" ||
      !/^[A-Z]{3}$/.test(item.currency) ||
      !text(snapshot.sku) ||
      !text(snapshot.name, 256)
    )
      return invalid();
    seen.add(item.productId);
    return {
      productId: item.productId,
      quantity: item.quantity,
      sellingUom: item.sellingUom,
      unitPrice: item.unitPrice,
      currency: item.currency,
      snapshot: { sku: snapshot.sku, name: snapshot.name },
    };
  });
  return {
    externalRequestReference: body.externalRequestReference,
    portalOrderId: body.portalOrderId.toLowerCase(),
    customerId: body.customerId,
    items,
  };
}
export function parseSubmissionScenario(
  value: string | undefined,
): SubmissionScenario {
  if (value === undefined) return "success";
  if (
    ![
      "success",
      "validation",
      "credit-hold",
      "insufficient-stock",
      "invalid-item",
    ].includes(value)
  )
    throw new OrderError(400, "INVALID_SCENARIO", "Unknown Mock ERP scenario.");
  return value as SubmissionScenario;
}

/** Terminal receipts are immutable for the process lifetime, with no hidden retry policy. */
export function createSubmissionService(orders: OrderService) {
  const receipts = new Map<string, { fingerprint: string; receipt: Receipt }>();
  const accepted = new Map<
    string,
    { orderFingerprint: string; receipt: Extract<Receipt, { order: unknown }> }
  >();
  function inspect(input: unknown) {
    const parsed = parse(input);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(parsed))
      .digest("hex");
    const existing = receipts.get(parsed.externalRequestReference);
    if (existing && existing.fingerprint !== fingerprint)
      throw new OrderError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "External request reference is already used for a different submission.",
      );
    if (!existing && receipts.size >= 1000)
      throw new OrderError(
        503,
        "SUBMISSION_CAPACITY_REACHED",
        "Mock submission capacity reached.",
      );
    return { parsed, fingerprint, existing };
  }
  return {
    replay(input: unknown): Receipt | null {
      return structuredClone(inspect(input).existing?.receipt ?? null);
    },
    submit(
      input: unknown,
      scenario: SubmissionScenario,
    ): { created: boolean; receipt: Receipt } {
      const { parsed, fingerprint, existing } = inspect(input);
      if (existing)
        return { created: false, receipt: structuredClone(existing.receipt) };
      if (
        ![
          "success",
          "validation",
          "credit-hold",
          "insufficient-stock",
          "invalid-item",
        ].includes(scenario)
      )
        throw new OrderError(
          400,
          "INVALID_SCENARIO",
          "Unknown Mock ERP scenario.",
        );
      const { externalRequestReference, portalOrderId, customerId, items } =
        parsed;
      const correlation = {
        externalRequestReference,
        portalOrderId,
        customerId,
      };
      const orderFingerprint = createHash("sha256")
        .update(JSON.stringify({ portalOrderId, customerId, items }))
        .digest("hex");
      const prior = accepted.get(portalOrderId);
      let receipt: Receipt;
      if (prior) {
        if (prior.orderFingerprint !== orderFingerprint)
          throw new OrderError(
            409,
            "ORDER_ALREADY_EXISTS",
            "Portal order already has a different Mock ERP submission.",
          );
        receipt = {
          ...correlation,
          outcome: "existing-order",
          order: prior.receipt.order,
        };
      } else if (scenario !== "success") {
        const failures = {
          validation: [
            "ERP_VALIDATION_FAILED",
            "Simulated ERP validation failure.",
          ],
          "credit-hold": ["CREDIT_HOLD", "Simulated customer credit hold."],
          "insufficient-stock": [
            "INSUFFICIENT_STOCK",
            "Simulated insufficient stock.",
          ],
          "invalid-item": ["INVALID_ITEM", "Simulated ERP invalid item."],
        } as const;
        const [code, message] = failures[scenario];
        receipt = {
          ...correlation,
          outcome: "rejected",
          rejection: { code, message },
        };
      } else {
        const result = orders.create(
          "submission:" +
            createHash("sha256").update(externalRequestReference).digest("hex"),
          {
            portalOrderId,
            customerId,
            items: items.map(({ productId, quantity }) => ({
              productId,
              quantity,
            })),
          },
        );
        receipt = {
          ...correlation,
          outcome: "accepted",
          order: { ...result.order, items },
        };
        accepted.set(portalOrderId, { orderFingerprint, receipt });
      }
      receipts.set(externalRequestReference, { fingerprint, receipt });
      return { created: true, receipt: structuredClone(receipt) };
    },
  };
}
