import test from "node:test";
import assert from "node:assert/strict";
import { validateSubmission } from "../dist/services/submission-validation.js";
const base = () => ({
  accountEligible: true,
  addressEligible: true,
  minimum: { amount: "1.5", currency: "AED" },
  lines: [
    {
      id: "line1",
      quantity: "0.125",
      product: {
        sellingUom: "KG",
        minimumOrderQuantity: "0.125",
        price: { amount: "10.125", currency: "AED" },
        availableQuantity: "0.125",
      },
    },
    {
      id: "line2",
      quantity: "0.5",
      product: {
        sellingUom: "CASE",
        minimumOrderQuantity: "0.25",
        price: { amount: "0.46875", currency: "AED" },
        availableQuantity: "0.5",
      },
    },
  ],
});
const codes = (input) => validateSubmission(input).map((i) => i.code);
test("validates an exact total at the minimum without rounding or inferred MOQ multiples", () => {
  const v = base();
  assert.deepEqual(validateSubmission(v), []);
  v.minimum.amount = "1.500000000000000001";
  assert.deepEqual(codes(v), ["BELOW_MINIMUM_ORDER_VALUE"]);
});
test("reports account, address, empty, product, UOM, MOQ, price and stock findings without disclosing data", () => {
  let v = base();
  v.accountEligible = false;
  v.addressEligible = false;
  v.lines = [];
  assert.deepEqual(codes(v), [
    "ACCOUNT_INELIGIBLE",
    "ADDRESS_UNAVAILABLE",
    "EMPTY_ORDER",
  ]);
  v = base();
  v.lines[0].product = null;
  assert.deepEqual(validateSubmission(v), [
    { code: "PRODUCT_UNAVAILABLE", itemId: "line1" },
  ]);
  v = base();
  v.lines[0].product.sellingUom = " ";
  v.lines[0].product.minimumOrderQuantity = "0.126";
  v.lines[0].product.price = null;
  v.lines[0].product.availableQuantity = "0.124999";
  assert.deepEqual(
    validateSubmission(v),
    [
      "SELLING_UOM_UNAVAILABLE",
      "BELOW_MOQ",
      "INSUFFICIENT_STOCK",
      "PRICE_UNAVAILABLE",
    ].map((code) => ({ code, itemId: "line1" })),
  );
});
test("unknown stock blocks; currency mismatch prevents misleading total comparisons", () => {
  const v = base();
  v.lines[0].product.availableQuantity = null;
  assert.deepEqual(codes(v), ["STOCK_UNKNOWN"]);
  v.lines[0].product.availableQuantity = "0.125";
  assert.deepEqual(codes(v), []);
  v.lines[1].product.price.currency = "USD";
  v.minimum.amount = "999999";
  assert.deepEqual(codes(v), ["PRICE_CURRENCY_MISMATCH"]);
});
test("invalid quantity and malformed source decimals fail closed", () => {
  const v = base();
  v.lines[0].quantity = "1e3";
  assert.deepEqual(codes(v), ["QUANTITY_INVALID"]);
  v.lines[0].quantity = "0.125";
  v.lines[0].product.minimumOrderQuantity = "bad";
  assert.throws(() => validateSubmission(v), TypeError);
  v.lines[0].product.minimumOrderQuantity = "0.125";
  v.minimum.currency = "bad";
  assert.throws(() => validateSubmission(v), TypeError);
  v.minimum.currency = "AED";
  v.lines[0].product.minimumOrderQuantity = "0";
  assert.throws(() => validateSubmission(v), TypeError);
  v.lines[0].product.minimumOrderQuantity = "0.125";
  v.lines[1].id = v.lines[0].id;
  assert.throws(() => validateSubmission(v), TypeError);
});
