import { NUMERIC_LITERAL, readNumeric, type Reading } from './display';

/**
 * Where the figures are in an answer, and which of them are claims about the
 * data at all.
 *
 * Half the numbers in a real answer are not claims: of sixty-one numeric tokens
 * across twelve answers from the configured model, twenty-eight were years or
 * the rank column of a table. A gate that checks all of them blocks the word
 * "2023"; one that waves through every small integer misses the answer that
 * says this dataset holds 48 companies when it holds 49. So the split is made
 * here, from the shapes those answers actually contained, and it is narrow:
 * a number is structure only when its shape and its position both say so.
 */

/** Where in the document a literal was found. A chart fence is verified as a block. */
export type Context = 'prose' | 'table' | 'chart';

/**
 * `figure` is checked against evidence. The other two are structure.
 *
 * `year` covers a bare four-digit integer in a plausible range, which is what
 * every one of those twenty-two tokens was. Whether the year is inside the
 * dataset's coverage is a different question with its own answer in the report
 * (`out_of_coverage`), and it needs the catalog, which this package does not have.
 *
 * `rank` is a position rather than an amount, and it is recognised two ways:
 * the leading cell of a table row holding a bare integer no larger than that
 * table's row count, or a bare integer wearing an ordinal suffix — "the 3rd
 * largest". Both are shapes, not guesses about meaning.
 *
 * A bare count in prose stays a `figure`, because `COUNT(*)` puts one in the
 * results and the difference between 48 and 49 companies is the whole point.
 */
export type Role = 'figure' | 'year' | 'rank';

export interface NumericLiteral {
  /** Exactly as written, so the gate can put the answer back together unchanged. */
  readonly text: string;
  /** Offset into the markdown it was read from. */
  readonly at: number;
  readonly reading: Reading;
  readonly context: Context;
  readonly role: Role;
}

/**
 * A fiscal year somebody might write about, and nothing wider. Every one of the
 * years observed in real answers is inside this, while `1000`–`2999` — the
 * obvious reading of "four digits" — would hand a free pass to two thousand bare
 * numbers, of which only two hundred could be years anybody means.
 *
 * A bare number in this range that is not a year still has somewhere to go:
 * `year` means the report checks it against the catalog rather than against the
 * results, and one outside the coverage comes back as `out_of_coverage`. What
 * this range decides is which of the two questions gets asked.
 */
const EARLIEST_YEAR = 1900n;
const LATEST_YEAR = 2099n;

const ORDINAL_SUFFIX = /^(?:st|nd|rd|th)\b/iu;
const TABLE_ROW = /^\s*\|/u;
const TABLE_DELIMITER = /^\s*\|[\s:|-]+\|\s*$/u;
const FENCE = /^\s*```/u;
const CHART_FENCE = /^\s*```chart\s*$/u;
const ALL_LITERALS = new RegExp(NUMERIC_LITERAL.source, 'giu');

interface Line {
  readonly text: string;
  readonly at: number;
  readonly context: Context;
  /** Rows in the table this line belongs to, excluding header and delimiter. */
  readonly tableRows: number;
}

function isTableAt(lines: readonly string[], index: number): boolean {
  const next = lines[index + 1];
  return next !== undefined && TABLE_DELIMITER.test(next);
}

/** Body rows of the table starting at `index`, which is its header line. */
function tableHeight(lines: readonly string[], index: number): number {
  let end = index + 2;
  // Past the last line the lookup is `undefined`, which fails the test and ends
  // the walk — so there is no separate length check to keep in step with it.
  while (TABLE_ROW.test(lines[end] ?? '')) end += 1;

  return end - index - 2;
}

/**
 * Body-row count, keyed by line, for the lines that belong to a table. A line
 * that is not in one is simply absent, which is what the lookup means.
 */
function tableHeights(raw: readonly string[]): ReadonlyMap<number, number> {
  const heights = new Map<number, number>();

  raw.forEach((text, index) => {
    if (!TABLE_ROW.test(text) || !isTableAt(raw, index)) return;

    const rows = tableHeight(raw, index);
    for (let line = index; line < index + 2 + rows; line += 1) heights.set(line, rows);
  });

  return heights;
}

/**
 * Line by line, because both things that change the reading of a number — a
 * fence and a table — are line-oriented in Markdown.
 *
 * A fence that is not a chart still counts as prose. A figure inside a code
 * block is a figure the reader sees, so skipping fenced content would leave a
 * hole in the gate, and calling it chart data would hand it to a check that
 * expects JSON.
 */
function scan(markdown: string): readonly Line[] {
  const raw = markdown.split('\n');
  const heights = tableHeights(raw);
  const lines: Line[] = [];
  let at = 0;
  let fence: Context | null = null;

  raw.forEach((text, index) => {
    if (FENCE.test(text)) {
      fence = fence === null ? (CHART_FENCE.test(text) ? 'chart' : 'prose') : null;
    }

    const rows = heights.get(index) ?? 0;
    lines.push({ text, at, context: fence ?? (rows > 0 ? 'table' : 'prose'), tableRows: rows });
    at += text.length + 1;
  });

  return lines;
}

/** Everything about a literal except the question this file exists to answer. */
type Found = Omit<NumericLiteral, 'role'> & { readonly column: number };

/** The index of the pipe-delimited cell containing `column`, or -1 outside a table. */
function cellIndexAt(line: Line, column: number): number {
  if (line.context !== 'table') return -1;

  let index = -1;
  for (let scanned = 0; scanned < column; scanned += 1) {
    if (line.text[scanned] === '|') index += 1;
  }

  return index;
}

/** A bare whole number: no currency, no percent, no separator, no decimals. */
function isBareInteger(found: Found): boolean {
  return (
    found.reading.kind === 'plain' &&
    found.reading.step.numerator === 1n &&
    found.reading.step.denominator === 1n &&
    !found.text.includes(',')
  );
}

function isYear(found: Found): boolean {
  return (
    isBareInteger(found) &&
    found.reading.ticks >= EARLIEST_YEAR &&
    found.reading.ticks <= LATEST_YEAR
  );
}

function inLeadingCell(found: Found, line: Line): boolean {
  return (
    cellIndexAt(line, found.column) === 0 &&
    found.reading.ticks >= 1n &&
    found.reading.ticks <= BigInt(line.tableRows)
  );
}

/**
 * "the 3rd largest". The suffix is what makes it a position rather than an
 * amount, and no figure this system produces ever carries one — so unlike the
 * bare count beside it, this one can be recognised by its shape alone.
 *
 * Grouping separators are allowed here where `isBareInteger` refuses them,
 * because `2,023rd` is a position however it is punctuated. What is still
 * refused is a currency marker, a percent sign or a decimal point: `$5th` is not
 * an ordinal, and neither is anything with a fraction.
 */
function isOrdinal(found: Found, line: Line): boolean {
  return (
    found.reading.kind === 'plain' &&
    found.reading.step.numerator === 1n &&
    found.reading.step.denominator === 1n &&
    ORDINAL_SUFFIX.test(line.text.slice(found.column + found.text.length))
  );
}

function isRank(found: Found, line: Line): boolean {
  return isOrdinal(found, line) || (isBareInteger(found) && inLeadingCell(found, line));
}

/**
 * Rank is settled before year, because an ordinal suffix is the more definite
 * signal of the two: `2023rd` is a position that happens to be spelled like a
 * year, and reading it as a year would let it through as structure without the
 * catalog ever seeing it. A year never wears a suffix, so nothing is lost.
 */
function roleOf(found: Found, line: Line): Role {
  if (isRank(found, line)) return 'rank';
  return isYear(found) ? 'year' : 'figure';
}

function literalsIn(line: Line): NumericLiteral[] {
  const found: NumericLiteral[] = [];
  ALL_LITERALS.lastIndex = 0;

  for (const match of line.text.matchAll(ALL_LITERALS)) {
    // Both use `NUMERIC_LITERAL`, so a match always reads back. The guard is
    // here because the type says it might, and a `!` would say it cannot when
    // nothing enforces that the two keep using the same pattern.
    const reading = readNumeric(match[0]);
    if (reading === null) continue;

    const at = { text: match[0], at: line.at + match.index, reading, context: line.context };
    found.push({ ...at, role: roleOf({ ...at, column: match.index }, line) });
  }

  return found;
}

/**
 * Every numeric literal in the answer, in the order it was written, each one
 * already labelled with whether it is a claim about the data.
 */
export function extractNumericClaims(markdown: string): readonly NumericLiteral[] {
  return scan(markdown).flatMap((line) => literalsIn(line));
}

/**
 * How far into a line the reading of it can no longer change, given that more
 * characters may still arrive. Everything before this point means what it will
 * always mean; everything after it is a figure that might still be growing.
 *
 * It lives beside the extractor because it is the same knowledge read from the
 * other side, and the two must not drift: the reach below covers the longest
 * suffix a literal can take (` trillion`) and the ordinal one after it, so a
 * literal ending within that distance of the end is still open.
 */
const SUFFIX_REACH = 12;

/** A sign or currency marker that has not met its digits yet. */
const PARTIAL_GUARD = 2;

export function settledPrefixOf(line: string): number {
  const matches = [...line.matchAll(ALL_LITERALS)];
  const last = matches.at(-1);
  if (last !== undefined && last.index + last[0].length + SUFFIX_REACH > line.length) {
    // Cutting at a literal's start is always safe to re-read from: the pattern
    // refuses to begin one after a digit or a point, so the character before it
    // can never have been part of a number.
    return last.index;
  }

  return Math.max(0, line.length - PARTIAL_GUARD);
}

/** A line that opens or closes a fenced block. */
export function isFenceLine(line: string): boolean {
  return FENCE.test(line);
}

/** A line that could belong to a table — whether it does depends on its neighbours. */
export function isTableRowLine(line: string): boolean {
  return TABLE_ROW.test(line);
}

/** A partial line that has not ruled out becoming a fence. */
export function couldOpenFence(line: string): boolean {
  return /^\s*`/u.test(line);
}
