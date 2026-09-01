/**
 * A query result, in the shape the model was shown it.
 *
 * This is deliberately the model-facing shape and not the `tool_result` message
 * part the browser receives. That one carries a preview cut to twenty rows,
 * which is the right thing to send a person and the wrong thing to build
 * evidence from: a figure the model read out of row twenty-one would have no
 * support and become a violation, on an answer that was correct.
 *
 * Values arrive as strings because that is how the driver returns `bigint` and
 * `numeric` without rounding them on the way — and `numeric` is what `sum()` and
 * `avg()` return, decimals and all.
 */

export interface ToolResult {
  readonly toolCallId: string;
  readonly columns: readonly string[];
  /** Row-major, aligned with `columns`. `null` is a value that was not recorded. */
  readonly rows: readonly (readonly (string | null)[])[];
}

/** A number found in a result, with where it was found. */
export interface Cell {
  readonly rowIndex: number;
  readonly column: string;
  readonly text: string;
}

const NUMERIC_TEXT = /^-?\d+(?:\.\d+)?$/u;

/**
 * Every cell that holds a number. A `null` is skipped rather than read as zero:
 * in this dataset a missing figure means nobody recorded it, and treating it as
 * zero would let "Goldman's revenue was $0" find support.
 */
export function numericCells(result: ToolResult): readonly Cell[] {
  const found: Cell[] = [];

  result.rows.forEach((row, rowIndex) => {
    result.columns.forEach((column, columnIndex) => {
      const text = row[columnIndex];
      if (text !== null && text !== undefined && NUMERIC_TEXT.test(text)) {
        found.push({ rowIndex, column, text });
      }
    });
  });

  return found;
}
