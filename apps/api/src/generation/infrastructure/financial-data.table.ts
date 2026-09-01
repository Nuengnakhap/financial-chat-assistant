/**
 * The one table the model may read, and what each of its columns holds.
 *
 * The column list is written here rather than read from the server because it is
 * a policy — the set of names a query is allowed to mention — and a policy that
 * widens itself the moment somebody adds a column is not one.
 * `financial-query.int.spec.ts` checks it against `information_schema` on a real
 * server, so a table that has moved on is a red test rather than a quiet
 * permission.
 *
 * Coverage is a different thing and is deliberately not here: which companies
 * and which years the table holds is read from it at runtime, because that
 * answer changes with the data and a copy of it in a source file would be a
 * second, wrong source of truth.
 */

export const FINANCIAL_DATA_TABLE = 'financial_data';

/**
 * What a column's values are. This is what decides whether a number gets a
 * display string: `$97.0B` against a fiscal year or a row count would be a
 * figure the model could copy and the gate would then refuse.
 */
export type ColumnUnit = 'usd' | 'year' | 'text';

export const FINANCIAL_DATA_COLUMNS: ReadonlyMap<string, ColumnUnit> = new Map<string, ColumnUnit>([
  ['company', 'text'],
  ['ticker', 'text'],
  ['sector', 'text'],
  ['year', 'year'],
  ['revenue', 'usd'],
  ['net_income', 'usd'],
  ['operating_income', 'usd'],
  ['gross_profit', 'usd'],
]);
