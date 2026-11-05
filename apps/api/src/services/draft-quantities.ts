import { DraftError, draftId } from "./order-drafts.js";
import type { DraftItem } from "../repositories/order-drafts.js";

/** Exact transport bound shared with the downstream submission adapter. No rounding. */
export function draftQuantity(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value) ||
    !/[1-9]/.test(value)
  )
    throw new DraftError("invalid_quantity");
  return value.includes(".")
    ? value.replace(/0+$/, "").replace(/\.$/, "")
    : value;
}
/** MOQ is a minimum, not an increment. Compare arbitrary catalog precision exactly. */
export function requireMinimum(quantity: string, minimum: string) {
  if (
    typeof minimum !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(minimum) ||
    !/[1-9]/.test(minimum)
  )
    throw new DraftError("unavailable");
  const [a, af = ""] = quantity.split("."),
    [b, bf = ""] = minimum.split(".");
  const scale = Math.max(af.length, bf.length);
  if (
    a.length < b.length ||
    (a.length === b.length &&
      (a < b || (a === b && af.padEnd(scale, "0") < bf.padEnd(scale, "0"))))
  )
    throw new DraftError("invalid_quantity");
}
/** Strict private persistence projection; never silently discard future item history. */
export function checkedDraftItems(value: unknown): DraftItem[] {
  try {
    if (!Array.isArray(value) || value.length > 100) throw new Error();
    const rows = Array.from(value, (raw) => {
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(",") !== "id,productId,quantity"
      )
        throw new Error();
      return {
        id: draftId(raw.id),
        productId: draftId(raw.productId),
        quantity: draftQuantity(raw.quantity),
      };
    });
    if (
      new Set(rows.map((r) => r.id)).size !== rows.length ||
      new Set(rows.map((r) => r.productId)).size !== rows.length
    )
      throw new Error();
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    throw new DraftError("unavailable");
  }
}
