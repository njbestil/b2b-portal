import { draftId } from "./order-drafts.js";
import { draftQuantity } from "./draft-quantities.js";
import { compareDecimals, submissionDecimal } from "./submission-decimal.js";
import type { DraftCommercialTerm } from "../repositories/order-drafts.js";
/** Treat malformed or unknown private fields as unavailable, never project them away. */
export function checkedCommercialTerms(value: unknown): DraftCommercialTerm[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new TypeError("Invalid commercial terms.");
  const terms = value.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(",") !==
        "amount,currency,itemId,productId,quantity" ||
      typeof row.currency !== "string" ||
      !/^[A-Z]{3}$/.test(row.currency)
    )
      throw new TypeError("Invalid commercial terms.");
    submissionDecimal(row.amount);
    return {
      itemId: draftId(row.itemId),
      productId: draftId(row.productId),
      quantity: draftQuantity(row.quantity),
      amount: row.amount,
      currency: row.currency,
    };
  });
  if (
    new Set(terms.map((t) => t.itemId)).size !== terms.length ||
    new Set(terms.map((t) => t.productId)).size !== terms.length
  )
    throw new TypeError("Duplicate commercial terms.");
  return terms.sort((a, b) => a.itemId.localeCompare(b.itemId));
}
export async function commercialToken(
  draftIdValue: string,
  version: string,
  terms: readonly DraftCommercialTerm[],
): Promise<string> {
  const input = new TextEncoder().encode(
    JSON.stringify([draftIdValue, version, terms]),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return (
    "terms-" +
    Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")
  );
}
export function commercialDifferences(
  baseline: readonly DraftCommercialTerm[] | null,
  current: readonly DraftCommercialTerm[],
) {
  if (
    !baseline ||
    baseline.length !== current.length ||
    baseline.some(
      (t, i) =>
        t.itemId !== current[i]?.itemId ||
        t.productId !== current[i]?.productId ||
        t.quantity !== current[i]?.quantity,
    )
  )
    return [{ code: "COMMERCIAL_TERMS_REQUIRED" as const }];
  return baseline.flatMap((term, i) =>
    term.currency !== current[i]!.currency ||
    compareDecimals(
      submissionDecimal(term.amount),
      submissionDecimal(current[i]!.amount),
    ) !== 0
      ? [{ code: "PRICE_CHANGED" as const, itemId: term.itemId }]
      : [],
  );
}
