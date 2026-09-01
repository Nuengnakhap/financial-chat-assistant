import type { Coverage } from './coverage';
import { formatUsd, readNumeric, valueOf } from './display';
import { roundToInteger } from './quantity';
import type { ToolResult } from './tool-result';
import { verify } from './verify';

/**
 * The answer of last resort, assembled from the query results and nothing else.
 *
 * No model writes this. When the drafts have run out of attempts, the reader
 * still gets the figures — correct, because they are the rows — with a sentence
 * saying why there is no summary around them. That is what makes the guarantee
 * total rather than probabilistic: there is no path where an unverified figure
 * reaches a reader, because the path that gives up shows only rows.
 *
 * Which means this must itself pass verification, always, and "always" is doing
 * real work. A company called "3M" would put a digit in a text column and the
 * verifier would read it as a claim; a column aliased `revenue_2023` would put a
 * year in a heading. Rather than enumerate what could go wrong in a value this
 * package does not control, the table is checked before it is offered, and a
 * table that does not pass is replaced by a sentence with no figures in it at
 * all. The last resort has a last resort.
 */

/** Nothing in this claims anything about the data, so nothing in it can be wrong. */
const NOTHING_VERIFIABLE =
  'A verified answer could not be produced for this question. Nothing is shown rather than something unchecked.';

const PREAMBLE = 'Here is the data behind your question, taken straight from the dataset.';

const EXPLANATION =
  'A written summary could not be checked against these figures this time, so the figures are shown on their own.';

/** A value that was never recorded. Not zero, and not a gap to be filled in. */
const NOT_RECORDED = '—';

function renderCell(text: string | null, column: string, coverage: Coverage): string {
  if (text === null) return NOT_RECORDED;
  if (coverage.columns.get(column) !== 'money') return text;

  // Rounding is safe here: the interval the display string stands for is wider
  // than half a unit at every scale, so the exact value stays inside it.
  const reading = readNumeric(text);
  return reading === null ? text : formatUsd(roundToInteger(valueOf(reading)));
}

function tableOf(result: ToolResult, coverage: Coverage): string {
  const header = `| ${result.columns.join(' | ')} |`;
  const rule = `|${result.columns.map(() => '---').join('|')}|`;
  const rows = result.rows.map((row) => {
    const cells = result.columns.map((column, index) =>
      renderCell(row[index] ?? null, column, coverage),
    );
    return `| ${cells.join(' | ')} |`;
  });

  return [header, rule, ...rows].join('\n');
}

export function buildSafeFallback(results: readonly ToolResult[], coverage: Coverage): string {
  const tables = results
    .filter((result) => result.rows.length > 0 && result.columns.length > 0)
    .map((result) => tableOf(result, coverage));
  if (tables.length === 0) return NOTHING_VERIFIABLE;

  const answer = [PREAMBLE, ...tables, EXPLANATION].join('\n\n');

  // Checked against the same verifier the drafts were, because an answer this
  // system wrote is not exempt from the rule this system exists to enforce.
  return verify(answer, results, coverage).verdict === 'pass' ? answer : NOTHING_VERIFIABLE;
}
