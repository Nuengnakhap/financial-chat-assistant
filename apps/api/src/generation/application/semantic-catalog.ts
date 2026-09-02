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
  return {
    years: catalog.years,
    columns: new Map(catalog.columns.map((column) => [column.name, column.kind])),
  };
}
