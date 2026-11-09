import test from "node:test";
import assert from "node:assert/strict";
import {
  submissionDecimal as d,
  compareDecimals as compare,
  addDecimals as add,
  multiplyDecimals as multiply,
} from "../dist/services/submission-decimal.js";

test("submission decimal arithmetic is exact across scales and does not round", () => {
  assert.equal(compare(d("0.100000000000000001"), d("0.1")), 1);
  assert.equal(compare(d("999999999999.999999"), d("1000000000000")), -1);
  assert.equal(compare(d("1.000"), d("1")), 0);
  assert.equal(compare(multiply(d("0.1"), d("0.2")), d("0.02")), 0);
  assert.equal(
    compare(add(multiply(d("0.125"), d("10.125")), d("0.234375")), d("1.5")),
    0,
  );
  assert.equal(
    compare(add(d("999999999999999999.9"), d("0.1")), d("1000000000000000000")),
    0,
  );
});

test("submission decimal parser rejects ambiguous, negative, and oversized values", () => {
  for (const value of [
    null,
    1,
    "",
    "-1",
    "+1",
    "01",
    "1e2",
    "1.",
    ".1",
    "NaN",
    "Infinity",
    "9".repeat(257),
  ])
    assert.throws(() => d(value), TypeError);
});
