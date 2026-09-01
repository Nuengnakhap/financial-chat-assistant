/**
 * What the dataset holds, as much of it as deciding a figure needs.
 *
 * Built from the database at runtime and handed in, never read from here: this
 * package has no connection and no business having one, and the coverage of a
 * dataset is not a constant to be typed into a source file.
 *
 * It is a projection of the catalog rather than the whole of it. A field nobody
 * checks is a field that quietly goes stale, so what is absent is as deliberate
 * as what is here — see `companies` below.
 */

export type ColumnKind = 'money' | 'plain';

export interface Coverage {
  /**
   * Every fiscal year present, in any company.
   *
   * Companies are deliberately absent, because a company name cannot be checked
   * in prose without being wrong more often than right: "Berkshire Hathaway's
   * 2023 net income is not available in this dataset" names one outside the
   * catalog and is the correct answer, and a rule that flagged the name would
   * reject it. The guarantee survives without it — a company outside the catalog
   * returns no rows, so a figure attributed to one has nothing supporting it and
   * fails the evidence check. That is the check that matters, and it is reached
   * structurally instead of by reading the sentence around the number.
   */
  readonly years: readonly number[];
  /**
   * The kind of each column of the table. A column that is absent — an alias the
   * model invented for an aggregate, say — is unknown rather than wrong, and a
   * figure supported only by an unknown column is left alone. Asserting a unit
   * mismatch there would be inventing a rule the data does not support.
   */
  readonly columns: ReadonlyMap<string, ColumnKind>;
}

export function coversYear(coverage: Coverage, year: bigint): boolean {
  return coverage.years.some((known) => BigInt(known) === year);
}
