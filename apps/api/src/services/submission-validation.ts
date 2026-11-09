import { draftQuantity } from "./draft-quantities.js";
import {
  addDecimals,
  compareDecimals,
  multiplyDecimals,
  submissionDecimal,
} from "./submission-decimal.js";

/** Inputs are resolved by a trusted server-side reader, never by the customer. */
export interface SubmissionValidationInput {
  readonly accountEligible: boolean;
  readonly addressEligible: boolean;
  readonly minimum: { readonly amount: string; readonly currency: string };
  readonly lines: readonly {
    readonly id: string;
    readonly quantity: string;
    /** Null means the product is missing, inactive or ineligible. */
    readonly product: {
      readonly sellingUom: string;
      readonly minimumOrderQuantity: string;
      readonly price: {
        readonly amount: string;
        readonly currency: string;
      } | null;
      readonly availableQuantity: string | null;
    } | null;
  }[];
}
export type SubmissionValidationIssue = {
  readonly code:
    | "ACCOUNT_INELIGIBLE"
    | "ADDRESS_UNAVAILABLE"
    | "EMPTY_ORDER"
    | "PRODUCT_UNAVAILABLE"
    | "SELLING_UOM_UNAVAILABLE"
    | "QUANTITY_INVALID"
    | "BELOW_MOQ"
    | "PRICE_UNAVAILABLE"
    | "PRICE_CURRENCY_MISMATCH"
    | "STOCK_UNKNOWN"
    | "INSUFFICIENT_STOCK"
    | "BELOW_MINIMUM_ORDER_VALUE";
  readonly itemId?: string;
};

/** The result is an immediate evaluation, not a reservation or permission to submit later. */
export function validateSubmission(
  input: SubmissionValidationInput,
): readonly SubmissionValidationIssue[] {
  const minimum = submissionDecimal(input.minimum.amount);
  if (
    !/^[A-Z]{3}$/.test(input.minimum.currency) ||
    typeof input.accountEligible !== "boolean" ||
    typeof input.addressEligible !== "boolean"
  )
    throw new TypeError("Invalid submission policy.");
  if (!Array.isArray(input.lines) || input.lines.length > 100)
    throw new TypeError("Invalid submission lines.");
  if (
    input.lines.some(
      (line) => !line || typeof line.id !== "string" || !line.id,
    ) ||
    new Set(input.lines.map((line) => line.id)).size !== input.lines.length
  )
    throw new TypeError("Invalid submission lines.");
  const issues: SubmissionValidationIssue[] = [];
  if (!input.accountEligible) issues.push({ code: "ACCOUNT_INELIGIBLE" });
  if (!input.addressEligible) issues.push({ code: "ADDRESS_UNAVAILABLE" });
  if (!input.lines.length) issues.push({ code: "EMPTY_ORDER" });
  let total = submissionDecimal("0"),
    totalKnown = input.lines.length > 0;
  for (const line of input.lines) {
    const issue = (code: SubmissionValidationIssue["code"]) =>
      issues.push({ code, itemId: line.id });
    const product = line.product;
    if (!product) {
      issue("PRODUCT_UNAVAILABLE");
      totalKnown = false;
      continue;
    }
    if (typeof product.sellingUom !== "string" || !product.sellingUom.trim())
      issue("SELLING_UOM_UNAVAILABLE");
    let quantity;
    try {
      quantity = submissionDecimal(draftQuantity(line.quantity));
    } catch {
      issue("QUANTITY_INVALID");
      totalKnown = false;
      continue;
    }
    const moq = submissionDecimal(product.minimumOrderQuantity);
    if (moq.coefficient === 0n) throw new TypeError("Invalid product minimum.");
    if (compareDecimals(quantity, moq) < 0) issue("BELOW_MOQ");
    if (product.availableQuantity === null) {
      issue("STOCK_UNKNOWN");
    } else if (
      compareDecimals(quantity, submissionDecimal(product.availableQuantity)) >
      0
    )
      issue("INSUFFICIENT_STOCK");
    if (!product.price) {
      issue("PRICE_UNAVAILABLE");
      totalKnown = false;
      continue;
    }
    if (!/^[A-Z]{3}$/.test(product.price.currency))
      throw new TypeError("Invalid product currency.");
    if (product.price.currency !== input.minimum.currency) {
      issue("PRICE_CURRENCY_MISMATCH");
      totalKnown = false;
      continue;
    }
    total = addDecimals(
      total,
      multiplyDecimals(quantity, submissionDecimal(product.price.amount)),
    );
  }
  if (totalKnown && compareDecimals(total, minimum) < 0)
    issues.push({ code: "BELOW_MINIMUM_ORDER_VALUE" });
  return issues;
}
