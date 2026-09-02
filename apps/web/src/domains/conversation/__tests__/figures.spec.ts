import { describe, expect, it } from 'vitest';

import { compactUsd } from '../utils/figures';

/**
 * How a figure reads on an axis. This is the only place in the browser that
 * formats a number: inside the answer the model copies the display string the
 * server produced from the row, and that string is what the verifier checked.
 */

describe('a figure on an axis', () => {
  it.each([
    [1_234_000_000_000, '$1.2T'],
    [391_035_000_000, '$391B'],
    [9_500_000_000, '$9.5B'],
    [96_995_000, '$97M'],
    [9_699_500, '$9.7M'],
    [12_400, '$12K'],
    [845, '$845'],
    [0, '$0'],
    [-9_500_000_000, '$-9.5B'],
  ])('reads %d as %s', (value, expected) => {
    // One decimal below ten and none above: `$391.0B` and `$1.2T` read at a
    // glance, and `$1234.5B` reads as neither a number nor a size.
    expect(compactUsd(value)).toBe(expected);
  });

  it('reads a value that came back as text, because every column does', () => {
    // The financial pool reads every column as text so nothing is rounded on
    // the way out of the database.
    expect(compactUsd('391035000000')).toBe('$391B');
  });

  it('says nothing rather than NaN for something that is not a number', () => {
    expect(compactUsd(null)).toBe('—');
    expect(compactUsd('not a figure')).toBe('—');
  });
});
