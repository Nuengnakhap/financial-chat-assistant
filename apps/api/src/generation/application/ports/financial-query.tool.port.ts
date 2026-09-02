import type { SqlRule } from './sql-policy.port';

/**
 * The one tool the model has, and the shape of what one call to it produced.
 *
 * Nothing here throws. A query the policy refused, a query the server refused
 * and a query that returned nothing are all outcomes with the same standing: the
 * model asked, something came back, and the next thing it does is decided by
 * what came back. An exception would end the generation instead, which is the
 * wrong answer to "that query was not allowed".
 */

/** `database` is the server refusing; the rest are the policy refusing. */
type FailureKind = SqlRule | 'database';

export interface ToolFailure {
  readonly kind: FailureKind;
  /**
   * Addressed to the model, which is the reader that can act on it. What a
   * person sees is wording chosen from `kind`, the way `DomainErrorFilter`
   * chooses wording from an error code.
   */
  readonly message: string;
}

export interface Truncation {
  readonly shown: number;
  readonly total: number;
  readonly hint: string;
}

export interface QueryOutcome {
  readonly toolCallId: string;
  /**
   * The statement that ran — the deparsed, canonical form rather than the text
   * the model wrote, because that is what a person is shown and what a log line
   * is about. `null` when the policy refused, since nothing was made canonical.
   */
  readonly sql: string | null;
  /** Empty when the query did not run. */
  readonly columns: readonly string[];
  /**
   * The rows the model was shown — after truncation, not before. Evidence is
   * built from these, because a figure from a row that was cut off was never in
   * front of the model, and one from row twenty-one of a result it did see must
   * not be treated as invented.
   */
  readonly rows: readonly (readonly (string | null)[])[];
  /**
   * Ready-made strings for the columns holding amounts, aligned with `rows`, so
   * the model can copy a figure instead of formatting one. Measured against the
   * configured model, not decorative: without it, it wrote SQL to format the
   * numbers itself and failed to finish two questions out of twelve.
   */
  readonly display: ReadonlyMap<string, readonly (string | null)[]>;
  /** How many rows the query returned, which is more than `rows` when cut. */
  readonly rowCount: number;
  readonly truncated: Truncation | null;
  readonly elapsedMs: number;
  readonly fromCache: boolean;
  readonly failure: ToolFailure | null;
}

export interface FinancialQueryTool {
  execute(toolCallId: string, sql: string): Promise<QueryOutcome>;
}

export const FINANCIAL_QUERY_TOOL = Symbol('FinancialQueryTool');
