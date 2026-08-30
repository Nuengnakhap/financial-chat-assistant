import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contrastRatio, parseOklch, type Oklch } from './oklch';

/**
 * Contrast is checked against the tokens that ship, not against a copy kept in a
 * test. Changing a lightness value in `tokens.css` and breaking a pair fails
 * here, which is the only way "≥ 4.5:1" is a rule rather than an intention.
 */

const TOKENS = readFileSync(join(import.meta.dirname, '..', 'tokens.css'), 'utf8');

function block(source: string, opener: string): string {
  const start = source.indexOf(opener);
  if (start === -1) throw new Error(`tokens.css has no ${opener} block`);
  const end = source.indexOf('\n}', start);
  return source.slice(start + opener.length, end);
}

function colours(source: string): Map<string, Oklch> {
  const found = new Map<string, Oklch>();
  for (const match of source.matchAll(/--color-([a-z0-9-]+):\s*oklch\(([^)/]+)\)/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) found.set(name, parseOklch(value));
  }
  return found;
}

const light = colours(block(TOKENS, '@theme {'));
// Dark only overrides; anything it leaves alone keeps the value above.
const dark = new Map([...light, ...colours(block(TOKENS, "[data-theme='dark'] {"))]);

const THEMES: readonly (readonly [string, Map<string, Oklch>])[] = [
  ['light', light],
  ['dark', dark],
];

/** Foreground, background, and what it is used for. */
const TEXT_PAIRS = [
  ['text', 'surface', 'body text in the application'],
  ['text', 'panel', 'body text in the rail and the list'],
  ['text', 'raised', 'text on a raised fill'],
  ['muted', 'surface', 'secondary text in the application'],
  ['muted', 'panel', 'secondary text in the list'],
  ['muted', 'raised', 'secondary text on a raised fill'],
  ['on-ink', 'ink', 'label on the primary action'],
  ['verified', 'surface', 'the verification badge and SQL keywords'],
  ['text', 'verified-soft', 'text on the verification fill'],
  ['text', 'positive-soft', 'text in a positive alert'],
  ['text', 'warning-soft', 'text in a warning alert'],
  ['text', 'negative-soft', 'text in a negative alert'],
  ['negative', 'surface', 'a field error message'],
] as const;

/**
 * Borders, rings and icons: WCAG 1.4.11 asks 3:1 of these, not 4.5:1. Every
 * edge that carries meaning is here — an alert's tone lives entirely in its left
 * border, so a tone nobody can see is a tone that is not there.
 */
const NON_TEXT_PAIRS = [
  ['verified', 'surface', 'the focus ring on the application'],
  ['verified', 'panel', 'the focus ring in the list'],
  ['line-strong', 'surface', 'the edge of an input'],
  ['line-strong', 'panel', 'the edge of a control in the list'],
  ['negative', 'surface', 'the edge of a rejected input'],
  ['verified', 'verified-soft', 'the edge of an informational alert'],
  ['positive', 'positive-soft', 'the edge of a positive alert'],
  ['warning', 'warning-soft', 'the edge of a warning alert'],
  ['negative', 'negative-soft', 'the edge of a negative alert'],
] as const;

describe('the arithmetic, before anything is trusted to it', () => {
  it('gives 21:1 for white against black', () => {
    expect(contrastRatio(parseOklch('1 0 0'), parseOklch('0 0 0'))).toBeCloseTo(21, 1);
  });

  it('gives 1:1 for a colour against itself', () => {
    const teal = parseOklch('0.48 0.11 175');

    expect(contrastRatio(teal, teal)).toBeCloseTo(1, 5);
  });

  it('refuses a value that is not three numbers', () => {
    expect(() => parseOklch('0.55 0.1')).toThrow(/oklch triple/);
    expect(() => parseOklch('0.55 0.1 teal')).toThrow(/non-number/);
  });
});

describe('every pair the interface renders', () => {
  it('found both themes in tokens.css', () => {
    // Otherwise a rename turns the whole suite into assertions about an empty map.
    expect(light.size).toBeGreaterThan(15);
    expect(dark.get('surface')).not.toEqual(light.get('surface'));
  });

  for (const [themeName, theme] of THEMES) {
    for (const [foreground, background, usage] of TEXT_PAIRS) {
      it(`${themeName}: ${usage} reaches 4.5:1`, () => {
        const fg = theme.get(foreground);
        const bg = theme.get(background);
        if (!fg || !bg)
          throw new Error(`--color-${foreground} or --color-${background} is missing`);

        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }

    for (const [foreground, background, usage] of NON_TEXT_PAIRS) {
      it(`${themeName}: ${usage} reaches 3:1`, () => {
        const fg = theme.get(foreground);
        const bg = theme.get(background);
        if (!fg || !bg)
          throw new Error(`--color-${foreground} or --color-${background} is missing`);

        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});
