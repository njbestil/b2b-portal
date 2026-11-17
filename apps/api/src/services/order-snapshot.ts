import type {
  OrderSnapshot,
  OrderSnapshotInput,
} from "../repositories/order-snapshots.js";
import { draftId } from "./order-drafts.js";
import { draftQuantity } from "./draft-quantities.js";
import {
  addDecimals,
  compareDecimals,
  multiplyDecimals,
  submissionDecimal,
  type SubmissionDecimal,
} from "./submission-decimal.js";

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    Array.from(value).some((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || n === 127 || (n >= 0xd800 && n <= 0xdfff);
    })
  )
    throw new TypeError("Invalid snapshot text.");
  return value;
}
function optionalText(value: unknown, maximum: number) {
  return value === null ? null : text(value, maximum);
}
function exact(value: SubmissionDecimal): string {
  const digits = value.coefficient.toString().padStart(value.scale + 1, "0");
  if (!value.scale) return digits;
  const rendered =
    digits.slice(0, -value.scale) + "." + digits.slice(-value.scale);
  return rendered.replace(/0+$/, "").replace(/\.$/, "");
}
/** Build a detached immutable value from already authorized, current server data.
 * This function does not authorize, lock, persist, or make a submission decision. */
export function createOrderSnapshot(input: OrderSnapshotInput): OrderSnapshot {
  const orderId = draftId(input.orderId),
    companyId = draftId(input.companyId);
  if (
    draftId(input.submittedBy.companyId) !== companyId ||
    draftId(input.delivery.companyId) !== companyId
  )
    throw new TypeError("Snapshot tenant mismatch.");
  if (!["CUSTOMER_ADMIN", "CUSTOMER_USER"].includes(input.submittedBy.role))
    throw new TypeError("Invalid submitting role.");
  if (
    typeof input.submittedAt !== "string" ||
    !Number.isFinite(Date.parse(input.submittedAt)) ||
    new Date(input.submittedAt).toISOString() !== input.submittedAt
  )
    throw new TypeError("Invalid snapshot time.");
  if (
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 100
  )
    throw new TypeError("Invalid snapshot items.");
  let total = submissionDecimal("0"),
    currency: string | undefined;
  const items = input.items.map((item) => {
    const itemId = draftId(item.itemId),
      productId = draftId(item.productId),
      quantity = draftQuantity(item.quantity);
    const q = submissionDecimal(quantity),
      moq = submissionDecimal(item.minimumOrderQuantity),
      price = submissionDecimal(item.unitPrice);
    if (moq.coefficient === 0n || compareDecimals(q, moq) < 0)
      throw new TypeError("Invalid snapshot quantity.");
    if (
      typeof item.currency !== "string" ||
      !/^[A-Z]{3}$/.test(item.currency) ||
      (currency !== undefined && currency !== item.currency)
    )
      throw new TypeError("Invalid snapshot currency.");
    currency = item.currency;
    const line = multiplyDecimals(q, price);
    total = addDecimals(total, line);
    return Object.freeze({
      itemId,
      productId,
      sku: text(item.sku, 128),
      name: text(item.name, 256),
      sellingUom: text(item.sellingUom, 256),
      minimumOrderQuantity: item.minimumOrderQuantity,
      quantity,
      unitPrice: item.unitPrice,
      currency: item.currency,
      lineTotal: exact(line),
    });
  });
  if (
    new Set(items.map((i) => i.itemId)).size !== items.length ||
    new Set(items.map((i) => i.productId)).size !== items.length ||
    !currency
  )
    throw new TypeError("Duplicate snapshot items.");
  return Object.freeze({
    schemaVersion: 1 as const,
    orderId,
    companyId,
    submittedAt: input.submittedAt,
    submittedBy: Object.freeze({
      id: draftId(input.submittedBy.id),
      displayName: text(input.submittedBy.displayName, 160),
      role: input.submittedBy.role,
    }),
    delivery: Object.freeze({
      id: draftId(input.delivery.id),
      label: text(input.delivery.label, 160),
      line1: text(input.delivery.line1, 500),
      contactName: optionalText(input.delivery.contactName, 160),
      contactPhone: optionalText(input.delivery.contactPhone, 40),
    }),
    items: Object.freeze(items),
    currency,
    total: exact(total),
  });
}

/** Reject malformed, incomplete, forged-total or extra-field persisted values. */
export function checkedOrderSnapshot(value: OrderSnapshot): OrderSnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    value.schemaVersion !== 1 ||
    !value.submittedBy ||
    !value.delivery ||
    !Array.isArray(value.items)
  )
    throw new TypeError("Invalid order snapshot.");
  const rebuilt = createOrderSnapshot({
    orderId: value.orderId,
    companyId: value.companyId,
    submittedAt: value.submittedAt,
    submittedBy: { ...value.submittedBy, companyId: value.companyId },
    delivery: { ...value.delivery, companyId: value.companyId },
    items: value.items.map(({ lineTotal: _lineTotal, ...item }) => item),
  });
  const stable = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(stable)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, stable(item)]),
          )
        : input;
  if (JSON.stringify(stable(value)) !== JSON.stringify(stable(rebuilt)))
    throw new TypeError("Invalid order snapshot.");
  return rebuilt;
}
