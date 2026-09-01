import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  add,
  compare,
  divide,
  exact,
  isInteger,
  isNegative,
  multiply,
  negate,
  ratio,
  roundToInteger,
  subtract,
  toApproximateNumber,
} from '../quantity';

describe('an exact rational', () => {
  it('keeps the sign on the numerator', () => {
    expect(ratio(1n, -2n)).toEqual({ numerator: -1n, denominator: 2n });
    expect(ratio(-1n, -2n)).toEqual({ numerator: 1n, denominator: 2n });
  });

  it('reduces, so a long sum does not grow a five-thousand-bit denominator', () => {
    // Adding two hundred eight-decimal values multiplies denominators at every
    // step unless they are reduced, and every later comparison then pays for it.
    const eightDecimals = ratio(157_282_577_777_777_777_78n, 10n ** 8n);
    let total = exact(0n);
    for (let index = 0; index < 200; index += 1) total = add(total, eightDecimals);

    expect(total.denominator).toBeLessThanOrEqual(10n ** 8n);
    expect(toApproximateNumber(total)).toBeCloseTo(200 * toApproximateNumber(eightDecimals), -3);
  });

  it('refuses a denominator of zero rather than producing an infinity', () => {
    expect(() => ratio(1n, 0n)).toThrow(RangeError);
    expect(() => divide(exact(1n), exact(0n))).toThrow(RangeError);
  });

  it('treats zero as zero however it was written', () => {
    expect(ratio(0n, 7n)).toEqual({ numerator: 0n, denominator: 1n });
  });

  it('compares without dividing', () => {
    expect(compare(ratio(1n, 3n), ratio(2n, 6n))).toBe(0);
    expect(compare(ratio(1n, 3n), ratio(1n, 2n))).toBe(-1);
    expect(compare(ratio(-1n, 3n), ratio(-1n, 2n))).toBe(1);
  });

  it('adds, subtracts, multiplies and divides exactly', () => {
    expect(add(ratio(1n, 3n), ratio(1n, 6n))).toEqual({ numerator: 1n, denominator: 2n });
    expect(subtract(ratio(1n, 2n), ratio(1n, 3n))).toEqual({ numerator: 1n, denominator: 6n });
    expect(multiply(ratio(2n, 3n), ratio(3n, 4n))).toEqual({ numerator: 1n, denominator: 2n });
    expect(divide(ratio(1n, 2n), ratio(1n, 4n))).toEqual({ numerator: 2n, denominator: 1n });
  });

  it('adds a third of a third of a third back to one', () => {
    // The sum a float gets wrong, and the reason none of this uses one.
    const third = ratio(1n, 3n);

    expect(add(add(third, third), third)).toEqual({ numerator: 1n, denominator: 1n });
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('negates and reports its sign', () => {
    expect(negate(ratio(1n, 2n))).toEqual({ numerator: -1n, denominator: 2n });
    expect(isNegative(ratio(-1n, 2n))).toBe(true);
    expect(isNegative(exact(0n))).toBe(false);
  });

  it('knows whether it is a whole number', () => {
    expect(isInteger(ratio(4n, 2n))).toBe(true);
    expect(isInteger(ratio(1n, 3n))).toBe(false);
  });
});

describe('rounding to the integer the contract stores', () => {
  it.each([
    { value: ratio(1n, 2n), expected: 1n },
    { value: ratio(-1n, 2n), expected: -1n },
    { value: ratio(3n, 2n), expected: 2n },
    { value: ratio(-3n, 2n), expected: -2n },
    { value: ratio(1n, 3n), expected: 0n },
    { value: ratio(2n, 3n), expected: 1n },
    { value: exact(-7n), expected: -7n },
  ])('rounds $value.numerator/$value.denominator to $expected', ({ value, expected }) => {
    expect(roundToInteger(value)).toBe(expected);
  });

  it('never moves a value by more than half', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
        fc.bigInt({ min: 1n, max: 10n ** 8n }),
        (numerator, denominator) => {
          const value = ratio(numerator, denominator);
          const rounded = roundToInteger(value);
          const drift = subtract(exact(rounded), value);

          expect(compare(multiply(drift, exact(2n)), exact(1n))).toBeLessThanOrEqual(0);
          expect(compare(multiply(drift, exact(2n)), exact(-1n))).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
