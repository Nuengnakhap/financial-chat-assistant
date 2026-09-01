import { add, compare, divide, exact, multiply, subtract, type Quantity } from './quantity';

/**
 * Formatting and tolerance are one decision, which is why they are one file.
 *
 * A display string does not name a value. It names the interval of values that
 * would have produced it: `$97.0B` is every amount that rounds to 97.0 at one
 * decimal of a billion, so it stands for `[96.95B, 97.05B]`. Read that way, the
 * tolerance rule is not a second, looser copy of the formatter — it is the
 * formatter read backwards, and a figure the model copied out of a tool result
 * is inside its own interval by construction rather than by luck.
 *
 * Everything a literal can be — a compact amount, a full one, a percentage —
 * reduces to the same two numbers: how many `ticks`, and what one tick is worth.
 * The half-tick either side follows, so `±0.05` for a percentage at one decimal
 * is derived here rather than stipulated somewhere else and kept in step by hand.
 */

/** What a numeric literal says, before anyone asks whether it is true. */
export interface Reading {
  /** The digits as a signed integer, with the decimal point taken out. */
  readonly ticks: bigint;
  /** What one tick is worth. `$97.0B` counts in hundred-millions. */
  readonly step: Quantity;
  /** `money` carries a currency marker, `percent` a `%`; `plain` is a bare number. */
  readonly kind: 'money' | 'percent' | 'plain';
}

/** The closed interval a reading stands for. Closed at both ends — see `bandOf`. */
export interface Band {
  readonly low: Quantity;
  readonly high: Quantity;
}

interface Magnitude {
  readonly suffix: string;
  /** Spelled out, because a model writes "$1.2 billion" as readily as "$1.2B". */
  readonly word: string;
  readonly unit: bigint;
}

/**
 * Largest first, so the scale an amount is written at is the first one it
 * reaches, and `compactFrom` can carry up by stepping one place earlier.
 */
const MAGNITUDES: readonly Magnitude[] = [
  { suffix: 'T', word: 'trillion', unit: 10n ** 12n },
  { suffix: 'B', word: 'billion', unit: 10n ** 9n },
  { suffix: 'M', word: 'million', unit: 10n ** 6n },
  { suffix: 'K', word: 'thousand', unit: 10n ** 3n },
];

/** One decimal is what the dataset's magnitudes need to stay distinguishable. */
const DECIMALS = 1n;

/** Every suffix that multiplies, lower-cased. Anything else leaves the value alone. */
const MAGNITUDE_BY_SUFFIX: ReadonlyMap<string, bigint> = new Map(
  MAGNITUDES.flatMap(({ suffix, word, unit }) => [
    [suffix.toLowerCase(), unit],
    [word, unit],
  ]),
);

/**
 * Both the ASCII hyphen and U+2212. A model that writes typographic quotes will
 * write a typographic minus, and reading `−$18.8B` as a positive amount would
 * turn a loss into a profit — the one misreading that inverts a claim rather
 * than merely misplacing it.
 */
const NEGATIVE_SIGNS = new Set(['-', '−']);

const CURRENCY_WORDS = new Set(['usd', 'dollars', 'dollar']);

/**
 * The one shape a numeric literal may take, shared by this module and the
 * extractor so the two can never disagree about where a literal ends.
 *
 * Three details in it are traps the probe found in real model output, not
 * defensive guesses:
 *
 * - `(?<![\d.])` before the sign, because `2022-2025` in a chart title would
 *   otherwise read as `2022` followed by minus 2025.
 * - a comma groups only when exactly three digits follow, because
 *   `…in 2025, while Microsoft…` would otherwise read as `2025,000`.
 * - `(?<fraction>\d+)` is required after the point, so `earned $5.` keeps its
 *   full stop instead of swallowing it into the number.
 */
export const NUMERIC_LITERAL =
  /(?<![\d.])(?<sign>[-+−])?(?<currency>\$)?(?<whole>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<fraction>\d+))?(?<suffix>[TBMK]\b|\s?(?:trillion|billion|million|thousand|USD|dollars?)\b)?(?<percent>%)?/iu;

/** Hoisted: `readNumeric` is called once per literal in every streamed delta. */
const WHOLE_LITERAL = new RegExp(`^(?:${NUMERIC_LITERAL.source})$`, 'iu');

interface Parts {
  readonly sign: string;
  readonly currency: string;
  readonly whole: string;
  readonly fraction: string;
  readonly suffix: string;
  readonly percent: string;
}

/** A group the pattern declares but the text may not have used. */
function group(groups: Record<string, string | undefined>, name: string): string {
  return groups[name] ?? '';
}

function partsOf(groups: Record<string, string | undefined>): Parts {
  return {
    sign: group(groups, 'sign'),
    currency: group(groups, 'currency'),
    whole: group(groups, 'whole'),
    fraction: group(groups, 'fraction'),
    suffix: group(groups, 'suffix').trim().toLowerCase(),
    percent: group(groups, 'percent'),
  };
}

function magnitudeOf(suffix: string): bigint {
  return MAGNITUDE_BY_SUFFIX.get(suffix) ?? 1n;
}

function kindOf(parts: Parts): Reading['kind'] {
  if (parts.percent !== '') return 'percent';
  if (parts.currency !== '' || CURRENCY_WORDS.has(parts.suffix)) return 'money';
  return 'plain';
}

/**
 * Reads a literal that has already been isolated. `null` when the text is not
 * exactly one literal, so a caller cannot quietly accept half of one.
 */
export function readNumeric(text: string): Reading | null {
  const match = WHOLE_LITERAL.exec(text);
  if (match?.groups === undefined) return null;

  const parts = partsOf(match.groups);
  const sign = NEGATIVE_SIGNS.has(parts.sign) ? -1n : 1n;
  const digits = `${parts.whole.replaceAll(',', '')}${parts.fraction}`;
  const decimals = BigInt(parts.fraction.length);

  return {
    ticks: sign * BigInt(digits),
    step: divide(exact(magnitudeOf(parts.suffix)), exact(10n ** decimals)),
    kind: kindOf(parts),
  };
}

/**
 * Closed at both ends, and it has to stay that way. Six values in this dataset
 * land exactly on a rounding boundary — Tesla's 2024 gross profit of
 * 17,450,000,000 is one — and they are inside the interval of both neighbouring
 * strings. Narrowing this to `[low, high)` to look stricter turns a correct
 * figure into a violation, which is the expensive direction to be wrong in.
 */
export function bandOf(reading: Reading): Band {
  const centre = valueOf(reading);
  const half = divide(reading.step, exact(2n));

  return { low: subtract(centre, half), high: add(centre, half) };
}

export function contains(band: Band, value: Quantity): boolean {
  return compare(band.low, value) <= 0 && compare(value, band.high) <= 0;
}

/** Three integer digits is where a scale ends; a fourth means the next one up. */
const SCALE_LIMIT = 1000n;

/**
 * `magnitude` is never negative here — the sign is put back by the caller, so
 * rounding only ever has to think about halves away from zero.
 *
 * An index outside the ladder is the terminating case, and it arrives two ways:
 * from `findIndex` returning -1 for an amount below a thousand, and from a value
 * that overflowed the largest scale there is.
 */
function compactFrom(magnitude: bigint, index: number): string {
  const scale = MAGNITUDES[index];
  if (scale === undefined) return magnitude.toString();

  const power = 10n ** DECIMALS;
  const ticks = (magnitude * power * 2n + scale.unit) / (scale.unit * 2n);
  // Rounding can carry a value into the next scale: 999,999,999 rounds to
  // 1000.0M, and nobody writes that when 1.0B is there to be written.
  if (ticks >= SCALE_LIMIT * power && index > 0) return compactFrom(magnitude, index - 1);

  const fraction = (ticks % power).toString().padStart(Number(DECIMALS), '0');
  return `${(ticks / power).toString()}.${fraction}${scale.suffix}`;
}

/**
 * The string a tool result hands the model to copy. Rounding happens in `bigint`
 * so that a value exactly on a boundary goes the way the arithmetic says rather
 * than the way a binary fraction happens to fall: `17450000000 / 1e9` is a
 * fraction slightly under 17.45, so `toFixed(1)` yields `17.4` while this yields
 * `17.5`. Both land inside their own interval, but only one of them is the
 * number a person would write.
 */
export function formatUsd(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  const sign = value < 0n ? '-' : '';

  return `${sign}$${compactFrom(
    magnitude,
    MAGNITUDES.findIndex((s) => magnitude >= s.unit),
  )}`;
}

/** What a reading is worth, exactly. A percentage is the number as written. */
export function valueOf(reading: Reading): Quantity {
  return multiply(exact(reading.ticks), reading.step);
}
