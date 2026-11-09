/** Exact nonnegative decimal arithmetic for submission checks. No floating point
 * or implicit currency rounding. Bounds are resource limits, not business rules. */
export interface SubmissionDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export function submissionDecimal(value: unknown): SubmissionDecimal {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  )
    throw new TypeError("Invalid exact decimal.");
  const [integer, fraction = ""] = value.split(".");
  return { coefficient: BigInt(integer + fraction), scale: fraction.length };
}

export function compareDecimals(a: SubmissionDecimal, b: SubmissionDecimal) {
  const scale = Math.max(a.scale, b.scale);
  const left = a.coefficient * 10n ** BigInt(scale - a.scale);
  const right = b.coefficient * 10n ** BigInt(scale - b.scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function addDecimals(
  a: SubmissionDecimal,
  b: SubmissionDecimal,
): SubmissionDecimal {
  const scale = Math.max(a.scale, b.scale);
  return {
    coefficient:
      a.coefficient * 10n ** BigInt(scale - a.scale) +
      b.coefficient * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

export function multiplyDecimals(
  a: SubmissionDecimal,
  b: SubmissionDecimal,
): SubmissionDecimal {
  return {
    coefficient: a.coefficient * b.coefficient,
    scale: a.scale + b.scale,
  };
}
