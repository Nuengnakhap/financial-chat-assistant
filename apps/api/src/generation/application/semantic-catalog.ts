import type { ColumnKind, Coverage } from '@fca/grounding';

/**
 * What this dataset holds, read from the dataset.
 *
 * Nothing about coverage is written down anywhere in this repository — not the
 * companies, not the years, not which columns have gaps. Replace the dump and
 * reseed, and the prompt, the refusals and the verifier's idea of what a valid
 * year is all move with it. That is the whole point of building this at runtime
 * rather than typing it into a source file, where it would be a second and
 * eventually wrong answer to the same question.
 *
 * The fingerprint is what makes the prompt cacheable: the system message is a
 * pure function of this catalog, so an unchanged fingerprint means a
 * byte-identical prefix, which is what a provider's automatic prompt caching
 * needs. Measured on the configured endpoint: 1,536 of 1,825 prompt tokens came
 * back as cached on the second call.
 */

export interface CatalogCompany {
  /** Spelled as the table spells it — which is what `WHERE company = …` needs. */
  readonly company: string;
  readonly ticker: string;
  readonly sector: string;
  /** The fiscal years this company actually has. Two companies do not have four. */
  readonly years: readonly number[];
}

export interface CatalogColumn {
  readonly name: string;
  readonly kind: ColumnKind;
  /** How many of the table's rows have a value here rather than a `NULL`. */
  readonly recorded: number;
}

export interface SemanticCatalog {
  readonly companies: readonly CatalogCompany[];
  readonly columns: readonly CatalogColumn[];
  readonly rows: number;
  /** Every year present in some company; no company is promised all of them. */
  readonly years: readonly number[];
  readonly fingerprint: string;
}

/**
 * The projection `packages/grounding` takes — years and column kinds, and
 * deliberately not the companies. A company name cannot be checked in prose
 * without being wrong more often than right: "Berkshire Hathaway's 2023 net
 * income is not in this dataset" names one outside the catalog and is the
 * correct answer. The guarantee survives without it, because a company outside
 * the catalog returns no rows and a figure attributed to one has nothing
 * supporting it.
 */
export function coverageOf(catalog: SemanticCatalog): Coverage {
  const table = new Map<string, ColumnKind>(
    catalog.columns.map((column): [string, ColumnKind] => [column.name, column.kind]),
  );

  // What `describe_coverage` answers with. A column the verifier has never
  // heard of is left alone, so a count of 190 under an unregistered name would
  // be evidence for "$190"; registering them as plain makes a dollar figure
  // resting on one a unit mismatch, which is what it is.
  for (const name of coverageColumns(catalog)) {
    refuseCollision(table, name);
    table.set(name, 'plain');
  }

  return { years: catalog.years, columns: table };
}

/**
 * The names `describe_coverage` uses are reserved, and this is where that is
 * said out loud rather than resolved by whichever entry was written last.
 *
 * The whole point of building the catalog from the database is that a reseed
 * moves the prompt, the refusals and the verifier together — so a dump with a
 * column called `first_year`, or one whose money column is called
 * `revenue_recorded`, is a thing that can happen. Letting the coverage name win
 * would quietly demote a money column to `plain`, and every figure read from it
 * would then be refused as a unit mismatch: a correct answer, thrown away, for
 * a reason nobody could find.
 *
 * Thrown rather than returned because it is unreachable with the dataset this
 * ships with. The caller is the catalog refresh, which logs and keeps the
 * reading it already had — so the failure is loud and the system stays up.
 */
function refuseCollision(table: ReadonlyMap<string, ColumnKind>, name: string): void {
  if (!table.has(name)) return;

  throw new Error(
    `The dataset has a column called "${name}", which is one of the names describe_coverage ` +
      'answers with. Rename the column, or rename what the tool calls it — they cannot be the ' +
      'same name, because one of them would have to lie about its unit.',
  );
}

/**
 * What `describe_coverage` answers, worked out from the catalog.
 *
 * It lives here rather than in the tool for one reason: these column names have
 * to be in `Coverage` as well. A column the verifier has never heard of is
 * unknown rather than wrong, and a figure supported only by an unknown column
 * is deliberately left alone — so a count of `190` under a name nobody
 * registered would be evidence for "$190". Naming the columns in one place is
 * what stops the two answers to "what columns can a result have" drifting apart.
 */

/** Fixed, and the same whatever the table holds. */
const FIXED_COLUMNS = ['rows', 'companies', 'first_year', 'last_year'] as const;

/** Only the amounts have gaps worth counting; the rest are filled in by definition. */
const isAmount = (column: CatalogColumn): boolean => column.kind === 'money';

/**
 * Deliberately not the column it counts. A column called `revenue` holding
 * `190` would be a money column to `packages/grounding`, and every count in
 * this result would become evidence for a dollar figure.
 */
const recordedColumn = (name: string): string => `${name}_recorded`;

export interface CoverageReport {
  readonly columns: readonly string[];
  readonly row: readonly string[];
  /**
   * The statement these figures answer — assembled here, and not the statement
   * that produced them: the catalog comes from two reads plus grouping done in
   * TypeScript, and neither of them counts distinct companies or takes the
   * range of the years. Running this would give the same numbers, which is what
   * makes it honest provenance rather than a decoration.
   *
   * It is also not run *now*: the catalog is refreshed on its own schedule, and
   * the outcome says so by setting `fromCache`. Coverage changes when somebody
   * reseeds a database, not between two questions.
   */
  readonly sql: string;
}

function coverageColumns(catalog: SemanticCatalog): readonly string[] {
  return [
    ...FIXED_COLUMNS,
    ...catalog.columns.filter(isAmount).map((column) => recordedColumn(column.name)),
  ];
}

export function coverageReport(catalog: SemanticCatalog): CoverageReport {
  const amounts = catalog.columns.filter(isAmount);
  const years = catalog.years;

  return {
    columns: coverageColumns(catalog),
    row: [
      String(catalog.rows),
      String(catalog.companies.length),
      String(years[0] ?? ''),
      String(years.at(-1) ?? ''),
      ...amounts.map((column) => String(column.recorded)),
    ],
    sql: statementFor(amounts),
  };
}

function statementFor(amounts: readonly CatalogColumn[]): string {
  const counts = amounts.map(
    (column) => `       count(${column.name}) AS ${recordedColumn(column.name)}`,
  );

  return [
    'SELECT count(*) AS rows,',
    '       count(DISTINCT company) AS companies,',
    '       min(year) AS first_year,',
    '       max(year) AS last_year,',
    ...counts,
    '  FROM financial_data',
  ]
    .map((line, index, lines) => (needsComma(index, lines) ? `${line},` : line))
    .join('\n');
}

/** Every line but the last of the select list ends in one, and the first four already do. */
function needsComma(index: number, lines: readonly string[]): boolean {
  return index >= 4 && index < lines.length - 2;
}
