import { contains, type Band } from './display';
import {
  add,
  compare,
  divide,
  exact,
  multiply,
  negate,
  ratio,
  subtract,
  type Quantity,
} from './quantity';
import { numericCells, type Cell, type ToolResult } from './tool-result';

/**
 * What the query results prove, and where each thing was proved.
 *
 * A support is not a boolean. Half the display strings this dataset produces
 * stand for a band that covers some other real value as well — `$10.6B` is
 * AMD's 2022 gross profit, Coca-Cola's 2024 net income and Eli Lilly's 2024 net
 * income at once — so "is this figure supported" has an answer that a `true`
 * cannot carry. Matching returns the places, and the report names one of them.
 *
 * Which also fixes what that provenance is allowed to claim: `toolCallId`,
 * `rowIndex` and `column` say *a cell that supports this figure*, never *the
 * cell the model was looking at*. Nothing in a finished string can prove the
 * second, and writing it as though it could would be the sort of claim this
 * package exists to refuse.
 */

export type Origin = 'cell' | 'row-count' | 'sum' | 'average' | 'difference' | 'growth';

export interface Support {
  readonly toolCallId: string;
  readonly column: string;
  /** The rows it was read from or computed over. Empty only for `row-count`. */
  readonly rows: readonly number[];
  readonly origin: Origin;
  /**
   * Exact, and deliberately not rounded here. A `numeric` from `avg()` arrives
   * with eight decimals and the model has been seen to copy it out verbatim, so
   * rounding on the way in would make the raw figure unsupported. `claim.value`
   * in `@fca/contracts` is an integer, and rounding belongs at that boundary.
   */
  readonly value: Quantity;
}

export interface EvidenceSet {
  /** Every support inside the band, nearest value first. Empty means no evidence. */
  match(band: Band): readonly Support[];
  readonly size: number;
}

/**
 * Above this many rows a result is a table somebody reads, not a comparison
 * somebody narrates — nobody writes a sentence about the growth between the
 * eleventh and the thirty-second row. Precomputing those pairs anyway would add
 * thousands of percentages to the set, and every extra value is another band a
 * fabricated figure could land in by chance. Twelve covers three companies over
 * the four years this dataset holds, which is the widest comparison the answers
 * observed actually make.
 */
const MAX_NARRATED_ROWS = 12;

const HUNDRED = exact(100n);

function quantityOf(text: string): Quantity {
  // The sign is taken off first: `-0.5` would otherwise lose it, because the
  // whole part parses to `-0` and a `bigint` has no negative zero.
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const digits = BigInt(`${whole}${fraction}`);

  return ratio(negative ? -digits : digits, 10n ** BigInt(fraction.length));
}

interface Column {
  readonly name: string;
  readonly cells: readonly Cell[];
}

function columnsOf(cells: readonly Cell[]): readonly Column[] {
  const byName = new Map<string, Cell[]>();
  for (const cell of cells) {
    const list = byName.get(cell.column);
    if (list === undefined) byName.set(cell.column, [cell]);
    else list.push(cell);
  }

  return [...byName].map(([name, list]) => ({ name, cells: list }));
}

function cellSupports(result: ToolResult, cells: readonly Cell[]): Support[] {
  return cells.map((cell) => ({
    toolCallId: result.toolCallId,
    column: cell.column,
    rows: [cell.rowIndex],
    origin: 'cell',
    value: quantityOf(cell.text),
  }));
}

/** Which query and which column a derived value belongs to. */
type Within = Pick<Support, 'toolCallId' | 'column'>;

function totals(within: Within, column: Column): Support[] {
  const values = column.cells.map((cell) => quantityOf(cell.text));
  if (values.length < 2) return [];

  const shared = { ...within, rows: column.cells.map((cell) => cell.rowIndex) };
  const sum = values.reduce((total, value) => add(total, value));

  return [
    { ...shared, origin: 'sum', value: sum },
    { ...shared, origin: 'average', value: divide(sum, exact(BigInt(values.length))) },
  ];
}

/**
 * Growth from a negative base is left out on purpose. Seven pairs in this
 * dataset have one, and the two defensible formulas disagree about the sign:
 * Intel going from −18.76B to −0.27B is either −98.6% or +98.6% depending on
 * whether the base keeps its sign. Supporting both would let a figure and its
 * negation pass the same check, so an answer about a loss is expected to state
 * the two amounts instead, which are cells.
 */
function pairSupports(within: Within, from: Cell, to: Cell): Support[] {
  const base = quantityOf(from.text);
  const moved = quantityOf(to.text);
  const shared = { ...within, rows: [from.rowIndex, to.rowIndex] };
  const change = subtract(moved, base);

  const supports: Support[] = [{ ...shared, origin: 'difference', value: change }];
  if (base.numerator > 0n) {
    supports.push({ ...shared, origin: 'growth', value: multiply(divide(change, base), HUNDRED) });
  }

  return supports;
}

function narratedPairs(within: Within, column: Column): Support[] {
  if (column.cells.length > MAX_NARRATED_ROWS) return [];

  const supports: Support[] = [];
  for (const from of column.cells) {
    for (const to of column.cells) {
      if (from !== to) supports.push(...pairSupports(within, from, to));
    }
  }

  return supports;
}

function rowCount(result: ToolResult): Support[] {
  if (result.rows.length === 0) return [];

  return [
    {
      toolCallId: result.toolCallId,
      column: '(row count)',
      rows: [],
      origin: 'row-count',
      value: exact(BigInt(result.rows.length)),
    },
  ];
}

function supportsOf(result: ToolResult): Support[] {
  const cells = numericCells(result);
  const columns = columnsOf(cells);

  return [
    ...cellSupports(result, cells),
    ...rowCount(result),
    ...columns.flatMap((column) => {
      const within = { toolCallId: result.toolCallId, column: column.name };
      return [...totals(within, column), ...narratedPairs(within, column)];
    }),
  ];
}

/**
 * What the figure as written denotes: the middle of the interval it named. The
 * interval is symmetric about it, so the two ends recover it exactly.
 */
function centreOf(band: Band): Quantity {
  return divide(add(band.low, band.high), exact(2n));
}

function distanceFrom(centre: Quantity, value: Quantity): Quantity {
  const gap = subtract(value, centre);
  return gap.numerator < 0n ? negate(gap) : gap;
}

/**
 * Nearest first, so a caller taking the head of the list gets the cell whose
 * value the figure is closest to rather than whichever one happens to sit at the
 * bottom of the interval.
 *
 * It matters because the report names one of these as provenance. `$10.6B`
 * covers AMD's 10,603,000,000, Eli Lilly's 10,590,000,000 and Coca-Cola's
 * 10,631,000,000; ordering by value alone would point at Eli Lilly every time,
 * which is a systematic bias towards the low end of every band rather than a
 * best reading of what was copied.
 */
function nearestFirst(found: readonly Support[], band: Band): readonly Support[] {
  const centre = centreOf(band);

  // A stable sort, so supports at equal distance keep the ascending order the
  // search found them in and the result never depends on how the set was built.
  return [...found].sort((left, right) =>
    compare(distanceFrom(centre, left.value), distanceFrom(centre, right.value)),
  );
}

/** Index of the first support at or above `value`; `sorted.length` if there is none. */
function lowerBound(sorted: readonly Support[], value: Quantity): number {
  let low = 0;
  let high = sorted.length;

  while (low < high) {
    const middle = (low + high) >>> 1;
    const at = sorted[middle];
    if (at !== undefined && compare(at.value, value) < 0) low = middle + 1;
    else high = middle;
  }

  return low;
}

/**
 * Sorted once at build time so a claim costs a binary search rather than a scan
 * of every value. Fifty rows is the widest result the query policy allows — it
 * writes that ceiling into the statement — and the set stays bounded by it.
 */
export function buildEvidenceSet(results: readonly ToolResult[]): EvidenceSet {
  const sorted = results
    .flatMap((result) => supportsOf(result))
    .sort((left, right) => compare(left.value, right.value));

  return {
    size: sorted.length,
    match(band: Band): readonly Support[] {
      const found: Support[] = [];
      for (let at = lowerBound(sorted, band.low); at < sorted.length; at += 1) {
        const support = sorted[at];
        if (support === undefined || !contains(band, support.value)) break;
        found.push(support);
      }

      return nearestFirst(found, band);
    },
  };
}
