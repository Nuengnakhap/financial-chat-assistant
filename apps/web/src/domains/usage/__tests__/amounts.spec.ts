import type { UsageView } from '@fca/contracts';
import { describe, expect, it } from 'vitest';

import { asDollars, shareUsed, timeUntil } from '../utils/amounts';

/**
 * Money as somebody reads it. Every figure arrives as an integer count of
 * micro-USD in a string, because JSON has only doubles — so this is the one
 * place in the browser where a budget becomes a number, and the only place a
 * rounding decision is made.
 */

const usage = (over: Partial<UsageView> = {}): UsageView => ({
  spentMicroUsd: '0',
  reservedMicroUsd: '0',
  limitMicroUsd: '1000000',
  remainingMicroUsd: '1000000',
  resetAt: '2026-09-02T15:00:00.000Z',
  exceeded: false,
  ...over,
});

describe('an amount on a meter', () => {
  it.each([
    ['0', '$0.00'],
    ['1000000', '$1.00'],
    ['420000', '$0.42'],
    ['1234567', '$1.24'],
  ])('reads %s micro-USD as %s', (micro, shown) => {
    expect(asDollars(micro)).toBe(shown);
  });

  it('rounds a fraction of a cent up rather than away', () => {
    // A tenth of a cent spent is money spent. `$0.00` beside a bar that has
    // moved reads as a meter that does not work.
    expect(asDollars('1')).toBe('$0.01');
    expect(asDollars('9999')).toBe('$0.01');
  });

  it('stays exact past what a double can hold', () => {
    // The whole reason these cross the wire as strings: `Number` would have
    // rounded this before it was ever divided.
    expect(asDollars('9007199254740993000000')).toBe('$9007199254740993.00');
  });
});

describe('how full a window is', () => {
  it('counts what is held as used, because it cannot be spent twice', () => {
    expect(shareUsed(usage({ spentMicroUsd: '200000', reservedMicroUsd: '300000' }))).toBeCloseTo(
      0.5,
      6,
    );
  });

  it('never reads past full, however far a window went over', () => {
    expect(shareUsed(usage({ spentMicroUsd: '4000000' }))).toBe(1);
  });

  it('reads a limit of nothing as full rather than dividing by it', () => {
    expect(shareUsed(usage({ limitMicroUsd: '0' }))).toBe(1);
  });
});

describe('how long until it resets', () => {
  const at = (iso: string): number => new Date(iso).getTime();

  it('counts in seconds once somebody is watching it', () => {
    expect(timeUntil('2026-09-02T15:00:00.000Z', at('2026-09-02T14:59:31.000Z'))).toBe(
      '29 seconds',
    );
    expect(timeUntil('2026-09-02T15:00:00.000Z', at('2026-09-02T14:59:59.000Z'))).toBe('1 second');
  });

  it('counts in minutes and hours when that is all anybody needs', () => {
    expect(timeUntil('2026-09-02T15:00:00.000Z', at('2026-09-02T14:52:00.000Z'))).toBe('8 minutes');
    expect(timeUntil('2026-09-02T15:00:00.000Z', at('2026-09-02T13:00:00.000Z'))).toBe('2 hours');
  });

  it('says none rather than a negative one for a window that has already turned', () => {
    expect(timeUntil('2026-09-02T15:00:00.000Z', at('2026-09-02T15:30:00.000Z'))).toBe('0 seconds');
  });
});
