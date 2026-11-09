import test from "node:test";
import assert from "node:assert/strict";
import { parseSubmissionMinimum } from "@b2b-portal/config/server";

test("submission minimum configuration is explicit, exact, bounded and redacted", () => {
  assert.equal(parseSubmissionMinimum({}), undefined);
  assert.deepEqual(
    parseSubmissionMinimum({
      SUBMISSION_MINIMUM_AMOUNT: "0.000000000000000001",
      SUBMISSION_MINIMUM_CURRENCY: "AED",
    }),
    { amount: "0.000000000000000001", currency: "AED" },
  );
  assert.deepEqual(
    parseSubmissionMinimum({
      SUBMISSION_MINIMUM_AMOUNT: "0",
      SUBMISSION_MINIMUM_CURRENCY: "USD",
    }),
    { amount: "0", currency: "USD" },
  );
  for (const env of [
    { SUBMISSION_MINIMUM_AMOUNT: "1" },
    { SUBMISSION_MINIMUM_CURRENCY: "AED" },
    { SUBMISSION_MINIMUM_AMOUNT: "-1", SUBMISSION_MINIMUM_CURRENCY: "AED" },
    { SUBMISSION_MINIMUM_AMOUNT: "1e3", SUBMISSION_MINIMUM_CURRENCY: "AED" },
    {
      SUBMISSION_MINIMUM_AMOUNT: "1.0000000000000000001",
      SUBMISSION_MINIMUM_CURRENCY: "AED",
    },
    {
      SUBMISSION_MINIMUM_AMOUNT: "1000000000000000000000000",
      SUBMISSION_MINIMUM_CURRENCY: "AED",
    },
    {
      SUBMISSION_MINIMUM_AMOUNT: "1",
      SUBMISSION_MINIMUM_CURRENCY: "do_not_leak",
    },
  ])
    assert.throws(
      () => parseSubmissionMinimum(env),
      (error) =>
        error.name === "EnvironmentConfigurationError" &&
        !error.message.includes("do_not_leak"),
    );
});
