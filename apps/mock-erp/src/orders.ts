import { createHash, randomUUID } from "node:crypto";
import { createMasterData } from "./master-data.js";

interface OrderInput {
  portalOrderId: string;
  customerId: string;
  items: { productId: string; quantity: string }[];
}

export interface MockErpOrder extends OrderInput {
  erpOrderId: string;
  createdAt: string;
  status: "created";
}

export class OrderError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function invalid(): never {
  throw new OrderError(400, "INVALID_ORDER", "Invalid order request.");
}

function objectWithKeys(
  input: unknown,
  keys: string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return invalid();
  if (
    Object.keys(input).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(input, key))
  )
    return invalid();
  return input as Record<string, unknown>;
}

function parseOrder(input: unknown): OrderInput {
  const body = objectWithKeys(input, ["portalOrderId", "customerId", "items"]);
  if (
    typeof body.portalOrderId !== "string" ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(body.portalOrderId) ||
    typeof body.customerId !== "string" ||
    !Array.isArray(body.items) ||
    body.items.length < 1 ||
    body.items.length > 100
  )
    return invalid();

  const seed = createMasterData();
  if (
    !seed.customers.some(
      (row) => row.customerId === body.customerId && row.active,
    )
  )
    return invalid();
  const seen = new Set<string>();
  const items = Array.from(body.items, (inputItem: unknown) => {
    const item = objectWithKeys(inputItem, ["productId", "quantity"]);
    if (
      typeof item.productId !== "string" ||
      !seed.products.some(
        (row) => row.productId === item.productId && row.active,
      ) ||
      seen.has(item.productId) ||
      typeof item.quantity !== "string" ||
      !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(item.quantity) ||
      !/[1-9]/.test(item.quantity)
    )
      return invalid();
    seen.add(item.productId);
    // Normalize exact decimal text without passing through a JS float.
    const quantity = item.quantity.includes(".")
      ? item.quantity.replace(/0+$/, "").replace(/\.$/, "")
      : item.quantity;
    return { productId: item.productId, quantity };
  });
  items.sort((a, b) => a.productId.localeCompare(b.productId, "en"));
  return {
    portalOrderId: body.portalOrderId.toLowerCase(),
    customerId: body.customerId,
    items,
  };
}

/** Demo-only, one ledger per app. No expiry/eviction that could permit duplicates. */
export function createOrderService() {
  const byKey = new Map<string, { fingerprint: string; order: MockErpOrder }>();
  const portalOrderIds = new Set<string>();

  function inspect(key: unknown, input: unknown) {
    if (
      typeof key !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)
    )
      throw new OrderError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "A valid Idempotency-Key is required.",
      );
    const parsed = parseOrder(input);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(parsed))
      .digest("hex");
    const existing = byKey.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new OrderError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key is already used for a different order request.",
        );
      return { key, parsed, fingerprint, existing: existing.order };
    }
    if (portalOrderIds.has(parsed.portalOrderId))
      throw new OrderError(
        409,
        "ORDER_ALREADY_EXISTS",
        "Portal order already has a Mock ERP order.",
      );
    if (byKey.size >= 1000)
      throw new OrderError(
        503,
        "ORDER_CAPACITY_REACHED",
        "Mock ERP order capacity reached.",
      );

    return { key, parsed, fingerprint, existing: undefined };
  }

  return {
    /** Validate and inspect without reserving anything; delayed scenarios must
     * still call create again before publication. Never bypass retained replay. */
    replay(key: unknown, input: unknown): MockErpOrder | null {
      const { existing } = inspect(key, input);
      return existing ? structuredClone(existing) : null;
    },
    create(
      key: unknown,
      input: unknown,
    ): { created: boolean; order: MockErpOrder } {
      const {
        key: validKey,
        parsed,
        fingerprint,
        existing,
      } = inspect(key, input);
      if (existing) return { created: false, order: structuredClone(existing) };
      // No await between lookup and publication: concurrent requests cannot race
      // on this single-process ledger. Do not reuse for distributed persistence.
      const order: MockErpOrder = {
        ...parsed,
        erpOrderId: randomUUID(),
        createdAt: new Date().toISOString(),
        status: "created",
      };
      byKey.set(validKey, { fingerprint, order });
      portalOrderIds.add(parsed.portalOrderId);
      return { created: true, order: structuredClone(order) };
    },
  };
}
