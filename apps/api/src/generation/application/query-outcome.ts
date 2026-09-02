import type { ToolResultRow } from '@fca/contracts';
import type { ToolResult } from '@fca/grounding';

import type { QueryOutcome } from './ports/financial-query.tool.port';

/**
 * The two readings of one query result, and why they are not the same object.
 *
 * The model gets JSON with a header and rows as arrays — around forty per cent
 * fewer tokens than a row of objects, and it repeats no column name — plus the
 * display strings and a note about what `NULL` means. Evidence gets the columns
 * and rows alone.
 *
 * The third reading is `toPreview`, which is what a person sees: rows as objects
 * with their column names, cut to twenty. Right for a table on a screen and
 * wrong for evidence — a figure the model read from row twenty-one would have no
 * support and become a violation, on an answer that was correct.
 */

/**
 * What the model is sent back for one tool call. Every field is optional because
 * a failure carries only `error`, and a result carries everything but.
 */
interface ModelFacingResult {
  readonly columns?: readonly string[];
  readonly rows?: readonly (readonly (string | null)[])[];
  readonly display?: Readonly<Record<string, readonly (string | null)[]>>;
  readonly rowCount?: number;
  readonly truncated?: { readonly shown: number; readonly total: number; readonly hint: string };
  readonly note?: string;
  readonly error?: string;
}

/**
 * Said again with every result rather than once in the prompt. The model has
 * been measured reading a `NULL` gross profit as zero and answering with the
 * arithmetic, and a rule stated forty messages ago is a rule it is reading
 * around a table of numbers.
 */
const NULL_MEANS_NOT_RECORDED = 'NULL means the value is not recorded in this dataset, not zero.';

export function toModelMessage(outcome: QueryOutcome): string {
  return JSON.stringify(modelFacingResult(outcome));
}

function modelFacingResult(outcome: QueryOutcome): ModelFacingResult {
  if (outcome.failure !== null) {
    // No empty columns, no zero row count: a result shape alongside an error
    // invites the model to read the error as "nothing matched", and answer from
    // memory instead of trying a query that works.
    return { error: outcome.failure.message };
  }

  return {
    columns: outcome.columns,
    rows: outcome.rows,
    ...(outcome.display.size > 0 ? { display: Object.fromEntries(outcome.display) } : {}),
    rowCount: outcome.rowCount,
    ...(outcome.truncated === null ? {} : { truncated: outcome.truncated }),
    note: NULL_MEANS_NOT_RECORDED,
  };
}

export function toEvidence(outcome: QueryOutcome): ToolResult {
  return { toolCallId: outcome.toolCallId, columns: outcome.columns, rows: outcome.rows };
}

/** What the browser is sent: named cells, and never more rows than a person reads. */
const PREVIEW_ROWS = 20;

export function toPreview(outcome: QueryOutcome): readonly ToolResultRow[] {
  return outcome.rows
    .slice(0, PREVIEW_ROWS)
    .map((row) =>
      Object.fromEntries(outcome.columns.map((column, index) => [column, row[index] ?? null])),
    );
}
