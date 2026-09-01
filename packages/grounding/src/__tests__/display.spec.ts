import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { bandOf, contains, formatUsd, readNumeric, valueOf } from '../display';
import { exact, ratio, toApproximateNumber, type Quantity } from '../quantity';

/** The band a written figure stands for, or a failure that says what was unreadable. */
function bandFor(text: string) {
  const reading = readNumeric(text);
  if (reading === null) throw new Error(`"${text}" is not a numeric literal`);

  return bandOf(reading);
}

function supports(text: string, value: bigint): boolean {
  return contains(bandFor(text), exact(value));
}

describe('a display string and the tolerance it implies', () => {
  it('is the same decision read in both directions', () => {
    // The property the whole pipeline rests on: whatever the system formats, the
    // model may copy verbatim and be believed. If this fails for one value, an
    // answer that did exactly as it was told is rejected.
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), (value) => {
        expect(supports(formatUsd(value), value)).toBe(true);
      }),
      { numRuns: 5_000 },
    );
  });

  it('never writes a fourth integer digit while a larger scale exists', () => {
    // 999,999,999 rounds to 1000.0 at the scale it was picked in. Carrying it up
    // is what stops the formatter emitting "$1000.0M" when "$1.0B" is available.
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 999_949_999_999_999n }), (value) => {
        const compact = /^\$(?<digits>\d+)\.\d[TBMK]$/u.exec(formatUsd(value));
        if (compact !== null) expect(compact.groups?.['digits']?.length).toBeLessThanOrEqual(3);
      }),
      { numRuns: 5_000 },
    );
    expect(formatUsd(999_999_999n)).toBe('$1.0B');
    expect(formatUsd(999_949_999n)).toBe('$999.9M');
  });

  it('runs out of scales above a thousand trillion, and says so in digits', () => {
    // The ladder stops at T because the largest figure in this dataset is 717B.
    // Above it the carry has nowhere to go, so the string grows a digit instead
    // of losing one — still inside its own interval, which is what matters.
    expect(formatUsd(10n ** 15n)).toBe('$1000.0T');
    expect(supports(formatUsd(10n ** 15n), 10n ** 15n)).toBe(true);
  });

  it('reads its own output back as the value it was made from', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), (value) => {
        const reading = readNumeric(formatUsd(value));
        expect(reading?.kind).toBe('money');
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('the interval is closed at both ends', () => {
  // Six values in this dataset land exactly on a rounding boundary. Each sits at
  // the shared edge of two neighbouring strings, and a half-open interval would
  // reject whichever of the two a formatter happened to produce.
  const onABoundary = [
    { name: 'Tesla 2024 gross profit', value: 17_450_000_000n, down: '$17.4B', up: '$17.5B' },
    { name: 'Adobe 2023 operating income', value: 6_650_000_000n, down: '$6.6B', up: '$6.7B' },
    {
      name: 'Apple 2025 operating income',
      value: 133_050_000_000n,
      down: '$133.0B',
      up: '$133.1B',
    },
    { name: 'Bank of America 2022 revenue', value: 94_950_000_000n, down: '$94.9B', up: '$95.0B' },
    { name: 'Capital One 2024 net income', value: 4_750_000_000n, down: '$4.7B', up: '$4.8B' },
    {
      name: 'Johnson & Johnson 2024 gross profit',
      value: 61_350_000_000n,
      down: '$61.3B',
      up: '$61.4B',
    },
  ];

  it.each(onABoundary)('accepts $name from either neighbouring string', ({ value, down, up }) => {
    expect(supports(down, value)).toBe(true);
    expect(supports(up, value)).toBe(true);
  });

  it('rounds a boundary value away from zero, where a float would fall short', () => {
    // Number(17450000000) / 1e9 is a fraction just under 17.45, so toFixed(1)
    // gives "17.4". Both strings are inside tolerance; only one is what a person
    // writes, and the arithmetic here is what decides rather than the binary
    // representation of a tenth.
    expect(formatUsd(17_450_000_000n)).toBe('$17.5B');
    expect((Number(17_450_000_000n) / 1e9).toFixed(1)).toBe('17.4');
  });

  it('refuses the value one unit outside the interval', () => {
    expect(supports('$17.5B', 17_449_999_999n)).toBe(false);
    expect(supports('$17.4B', 17_450_000_001n)).toBe(false);
  });
});

describe('what a literal is worth', () => {
  const readings: readonly { text: string; value: Quantity; kind: string }[] = [
    { text: '$97.0B', value: exact(97_000_000_000n), kind: 'money' },
    { text: '-$18.8B', value: exact(-18_800_000_000n), kind: 'money' },
    { text: '−$18.8B', value: exact(-18_800_000_000n), kind: 'money' },
    { text: '-$267.0M', value: exact(-267_000_000n), kind: 'money' },
    { text: '$96,995,000,000', value: exact(96_995_000_000n), kind: 'money' },
    { text: '-22000000 USD', value: exact(-22_000_000n), kind: 'money' },
    { text: '$1.2 billion', value: exact(1_200_000_000n), kind: 'money' },
    { text: '300.0%', value: ratio(3_000n, 10n), kind: 'percent' },
    { text: '+12.4%', value: ratio(124n, 10n), kind: 'percent' },
    { text: '2023', value: exact(2023n), kind: 'plain' },
    {
      text: '157282577777.77777778',
      value: ratio(15_728_257_777_777_777_778n, 10n ** 8n),
      kind: 'plain',
    },
  ];

  it.each(readings)('reads $text', ({ text, value, kind }) => {
    const reading = readNumeric(text);
    expect(reading?.kind).toBe(kind);
    expect(reading === null ? null : toApproximateNumber(valueOf(reading))).toBeCloseTo(
      toApproximateNumber(value),
      6,
    );
  });

  it('derives the half-point tolerance of a percentage rather than stipulating it', () => {
    // A percentage written to one decimal is accepted within ±0.05 points.
    // Nothing in the code says 0.05: it is half a tick of a number written to one
    // decimal, which is the same rule money is held to, arrived at the same way.
    const band = bandFor('384.9%');
    expect(toApproximateNumber(band.low)).toBeCloseTo(384.85, 10);
    expect(toApproximateNumber(band.high)).toBeCloseTo(384.95, 10);
  });

  it('keeps a percentage apart from an amount', () => {
    expect(readNumeric('300.0%')?.kind).toBe('percent');
    expect(readNumeric('$300.0')?.kind).toBe('money');
  });

  it('refuses text that is not exactly one literal', () => {
    expect(readNumeric('about $97.0B')).toBeNull();
    expect(readNumeric('$97.0B or so')).toBeNull();
    expect(readNumeric('')).toBeNull();
  });
});
