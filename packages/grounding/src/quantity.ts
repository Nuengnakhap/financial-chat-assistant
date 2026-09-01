/**
 * An exact rational. Every value the grounding layer compares is one of these,
 * and none of them is a float.
 *
 * Money in this dataset is whole USD in a `bigint`, but the values an answer is
 * allowed to state are not all integers: an average is a sum over a count, and a
 * growth rate is a difference over a base. Computing either in a `number` puts a
 * rounding error between the figure the model copied and the figure we hold, at
 * exactly the resolution the tolerance rule is deciding on — so the two would
 * disagree about the last digit, which is the only digit in question.
 */

export interface Quantity {
  readonly numerator: bigint;
  /** Always positive, so a comparison never has to reason about the sign of the divisor. */
  readonly denominator: bigint;
}

export function exact(value: bigint): Quantity {
  return { numerator: value, denominator: 1n };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];

  return a;
}

/**
 * Reduced on the way in. Nothing here needs a canonical form to be *correct* —
 * comparison cross-multiplies — but summing a column of eight-decimal averages
 * multiplies the denominators together at every step, and two hundred rows of
 * that is a five-thousand-bit integer behind every later comparison. Reducing
 * costs one gcd and keeps the numbers the size of the values they describe.
 */
export function ratio(numerator: bigint, denominator: bigint): Quantity {
  if (denominator === 0n) throw new RangeError('A quantity cannot have a zero denominator.');

  // `denominator` is non-zero, so the divisor is too, whatever the numerator is.
  const signed = denominator < 0n ? -1n : 1n;
  const divisor = greatestCommonDivisor(numerator, denominator);

  return {
    numerator: (signed * numerator) / divisor,
    denominator: (signed * denominator) / divisor,
  };
}

/** Cross-multiplied rather than divided: both sides stay integers, so equality is equality. */
export function compare(left: Quantity, right: Quantity): -1 | 0 | 1 {
  const l = left.numerator * right.denominator;
  const r = right.numerator * left.denominator;
  if (l < r) return -1;
  return l > r ? 1 : 0;
}

export function isNegative(value: Quantity): boolean {
  return value.numerator < 0n;
}

export function negate(value: Quantity): Quantity {
  return { numerator: -value.numerator, denominator: value.denominator };
}

export function add(left: Quantity, right: Quantity): Quantity {
  return ratio(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function subtract(left: Quantity, right: Quantity): Quantity {
  return add(left, negate(right));
}

export function multiply(left: Quantity, right: Quantity): Quantity {
  return ratio(left.numerator * right.numerator, left.denominator * right.denominator);
}

export function divide(left: Quantity, right: Quantity): Quantity {
  if (right.numerator === 0n) throw new RangeError('A quantity cannot be divided by zero.');

  return ratio(left.numerator * right.denominator, left.denominator * right.numerator);
}

/**
 * Nearest integer, halves away from zero — the rounding a person does, and the
 * one a display string implies. Used where a value has to become the integer
 * `claim.value` in `@fca/contracts`, which is a base-10 integer string.
 */
export function roundToInteger(value: Quantity): bigint {
  const { numerator, denominator } = value;
  const doubled = numerator * 2n;
  return numerator < 0n
    ? -((-doubled + denominator) / (denominator * 2n))
    : (doubled + denominator) / (denominator * 2n);
}

export function isInteger(value: Quantity): boolean {
  return value.numerator % value.denominator === 0n;
}

/** Debugging and test failures only. Lossy above 2^53, like every float. */
export function toApproximateNumber(value: Quantity): number {
  return Number(value.numerator) / Number(value.denominator);
}
