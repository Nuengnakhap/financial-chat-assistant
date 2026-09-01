import type { CanonicalSql, Result } from '@fca/domain';

/**
 * The gate between SQL the model wrote and SQL that runs.
 *
 * A rejection is a value and not an exception, because it is not a failure of
 * the system: the model wrote a query that is not allowed, and the answer to
 * that is to hand it back the reason and let it write another one. Only a bug
 * throws.
 */

/**
 * Why a query was refused, as a closed set — so a violation can be counted per
 * rule without parsing its message. A spike in `table` or `construct` is a
 * different event from a spike in `syntax`: one is a model with a broken idea of
 * the schema, the other is someone probing.
 */
export const SQL_RULES = [
  'length',
  'syntax',
  'empty',
  'multiple_statements',
  'not_a_select',
  'no_result_columns',
  'duplicate_column',
  'construct',
  'table',
  'no_table',
  'column',
  'function',
  'type',
] as const;

export type SqlRule = (typeof SQL_RULES)[number];

export interface SqlViolation {
  readonly rule: SqlRule;
  /**
   * Written for the model, which is the only reader that can act on it: it says
   * what was wrong and what is allowed instead. It is never shown to a person as
   * it stands — the tool card in the UI renders wording chosen from `rule`, the
   * same way `DomainErrorFilter` chooses wording from a code.
   */
  readonly message: string;
}

export interface QueryPlan {
  /** The deparsed form of the tree that was accepted. Nothing else is executed. */
  readonly sql: CanonicalSql;
  /**
   * The result columns whose values are amounts in USD, worked out from the
   * query rather than from the column names it comes back with — `sum(revenue)`
   * arrives named `sum`, and a name is not a unit.
   *
   * This is what decides which columns get a display string, and the display
   * strings are what the model copies instead of formatting a figure itself.
   */
  readonly usdColumns: ReadonlySet<string>;
}

export interface SqlPolicy {
  validate(raw: string): Result<QueryPlan, SqlViolation>;
}

export const SQL_POLICY = Symbol('SqlPolicy');
