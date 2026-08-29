import { describe, expect, it } from 'vitest';

import { MicroUsd } from '../micro-usd.vo';

describe('construction', () => {
  it('exposes zero', () => {
    expect(MicroUsd.ZERO.micro).toBe(0n);
    expect(MicroUsd.ZERO.isZero).toBe(true);
  });

  it('converts dollars to micro-USD', () => {
    expect(MicroUsd.fromUsd(1).micro).toBe(1_000_000n);
    expect(MicroUsd.fromUsd(0.2).micro).toBe(200_000n);
    expect(MicroUsd.fromUsd(0.000_001).micro).toBe(1n);
  });

  it('rounds a sub-micro amount to the nearest micro', () => {
    expect(MicroUsd.fromUsd(0.000_000_4).micro).toBe(0n);
    expect(MicroUsd.fromUsd(0.000_000_6).micro).toBe(1n);
  });

  it('rejects a non-finite amount, because that is a caller bug', () => {
    expect(() => MicroUsd.fromUsd(Number.NaN)).toThrow(TypeError);
    expect(() => MicroUsd.fromUsd(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('round-trips the canonical string form used by the database and the wire', () => {
    const original = MicroUsd.fromMicro(123_456_789n);
    expect(MicroUsd.fromMicroString(original.toString()).equals(original)).toBe(true);
    expect(MicroUsd.fromMicroString('-42').micro).toBe(-42n);
  });

  it('rejects a string that is not an integer', () => {
    expect(() => MicroUsd.fromMicroString('1.5')).toThrow(TypeError);
    expect(() => MicroUsd.fromMicroString('1e6')).toThrow(TypeError);
    expect(() => MicroUsd.fromMicroString('')).toThrow(TypeError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly where floating point would drift', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; this is the whole reason the type exists.
    const total = MicroUsd.fromUsd(0.1).plus(MicroUsd.fromUsd(0.2));

    expect(total.micro).toBe(300_000n);
    expect(total.equals(MicroUsd.fromUsd(0.3))).toBe(true);
  });

  it('accumulates a thousand small charges without losing a micro', () => {
    const charges = Array.from({ length: 1000 }, () => MicroUsd.fromUsd(0.000_07));
    expect(MicroUsd.sum(charges).micro).toBe(70_000n);
  });

  it('sums an empty list to zero', () => {
    expect(MicroUsd.sum([]).equals(MicroUsd.ZERO)).toBe(true);
  });

  it('allows a negative result, which is how remaining budget is expressed', () => {
    const remaining = MicroUsd.fromUsd(1).minus(MicroUsd.fromUsd(1.5));

    expect(remaining.micro).toBe(-500_000n);
    expect(remaining.isNegative).toBe(true);
  });

  it('multiplies by a token count', () => {
    expect(MicroUsd.fromMicro(3n).times(1_000_000n).micro).toBe(3_000_000n);
  });

  it('stays exact far beyond the safe integer range', () => {
    const huge = MicroUsd.fromMicro(9_007_199_254_740_993n);
    expect(huge.plus(MicroUsd.fromMicro(1n)).toString()).toBe('9007199254740994');
  });
});

describe('dividedBy', () => {
  it('rounds a charge up, so the budget is never quietly undercharged', () => {
    // $0.20 per million tokens, 7 tokens: 1.4 micro must cost 2, not 1.
    const perMillion = MicroUsd.fromUsd(0.2);
    const cost = perMillion.times(7n).dividedBy(1_000_000n, 'up');

    expect(cost.micro).toBe(2n);
  });

  it('rounds down when asked', () => {
    expect(MicroUsd.fromMicro(7n).dividedBy(2n, 'down').micro).toBe(3n);
  });

  it('does not round an exact division', () => {
    expect(MicroUsd.fromMicro(6n).dividedBy(2n, 'up').micro).toBe(3n);
    expect(MicroUsd.fromMicro(6n).dividedBy(2n, 'down').micro).toBe(3n);
  });

  it('rounds a negative quotient towards positive infinity for "up"', () => {
    expect(MicroUsd.fromMicro(-7n).dividedBy(2n, 'up').micro).toBe(-3n);
    expect(MicroUsd.fromMicro(7n).dividedBy(-2n, 'up').micro).toBe(-3n);
    expect(MicroUsd.fromMicro(-7n).dividedBy(-2n, 'up').micro).toBe(4n);
  });

  it('rounds a negative quotient towards negative infinity for "down"', () => {
    // BigInt division truncates towards zero, so without a correction "down"
    // would return -3 here and quietly become a second spelling of "up".
    expect(MicroUsd.fromMicro(-7n).dividedBy(2n, 'down').micro).toBe(-4n);
    expect(MicroUsd.fromMicro(7n).dividedBy(-2n, 'down').micro).toBe(-4n);
    expect(MicroUsd.fromMicro(-7n).dividedBy(-2n, 'down').micro).toBe(3n);
  });

  it('keeps the two directions one apart whenever the division is inexact', () => {
    const cases: readonly [bigint, bigint][] = [
      [7n, 2n],
      [-7n, 2n],
      [7n, -2n],
      [-7n, -2n],
      [1n, 3n],
      [-1n, 3n],
    ];

    for (const [micro, divisor] of cases) {
      const up = MicroUsd.fromMicro(micro).dividedBy(divisor, 'up');
      const down = MicroUsd.fromMicro(micro).dividedBy(divisor, 'down');
      expect(up.minus(down).micro).toBe(1n);
    }
  });

  it('refuses to divide by zero', () => {
    expect(() => MicroUsd.fromMicro(1n).dividedBy(0n, 'up')).toThrow(RangeError);
  });
});

describe('comparison', () => {
  const small = MicroUsd.fromUsd(1);
  const large = MicroUsd.fromUsd(2);

  it('orders two amounts', () => {
    expect(small.compare(large)).toBe(-1);
    expect(large.compare(small)).toBe(1);
    expect(small.compare(MicroUsd.fromUsd(1))).toBe(0);
  });

  it('answers the questions the budget check asks', () => {
    expect(large.isGreaterThan(small)).toBe(true);
    expect(large.isLessThan(small)).toBe(false);
    expect(small.isLessThan(large)).toBe(true);
    expect(small.equals(MicroUsd.fromMicro(1_000_000n))).toBe(true);
  });

  it('sorts by value, not by object identity', () => {
    const sorted = [large, MicroUsd.ZERO, small].sort((a, b) => a.compare(b));
    expect(sorted.map((amount) => amount.toString())).toEqual(['0', '1000000', '2000000']);
  });
});

describe('output', () => {
  it('serialises to the exact string, since JSON cannot hold a bigint', () => {
    const amount = MicroUsd.fromMicro(1_234_567n);

    expect(JSON.stringify({ amount })).toBe('{"amount":"1234567"}');
    expect(amount.toString()).toBe('1234567');
  });

  it('converts to a number for display only', () => {
    expect(MicroUsd.fromMicro(1_234_567n).toUsdNumber()).toBeCloseTo(1.234_567, 6);
  });
});
