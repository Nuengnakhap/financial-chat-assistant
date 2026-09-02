import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { FINANCIAL_DATA_COLUMNS, type ColumnUnit } from './financial-data.table';
import { FinancialQueryPool, type QueryRows } from '../../shared/financial/financial-query.pool';
import type { CatalogSource } from '../application/ports/semantic-catalog.port';
import type {
  CatalogColumn,
  CatalogCompany,
  SemanticCatalog,
} from '../application/semantic-catalog';

/**
 * Reads the table and says what is in it.
 *
 * Two queries and no assumptions: which companies exist with which years, and
 * how much of each column is actually recorded. Everything downstream — the
 * prompt, the years a figure may be attributed to, the sentence said when the
 * answer is not there — comes from this and from nowhere else, so a different
 * dump changes all of them together.
 *
 * The fingerprint covers the catalog and the format it is rendered in, because
 * what it is for is deciding whether the prompt prefix is byte-identical. It
 * hashes a normalised form rather than the row order the database happened to
 * return, so the same data read twice fingerprints the same.
 */

/** Bumped when `renderSystemPrompt` changes shape, since the prefix then differs. */
const CATALOG_FORMAT = 1;

@Injectable()
export class SemanticCatalogBuilder implements CatalogSource {
  constructor(private readonly pool: FinancialQueryPool) {}

  async build(): Promise<SemanticCatalog> {
    const [companyRows, recordedRow] = await Promise.all([
      this.pool.readCatalog('companies'),
      this.pool.readCatalog('recorded'),
    ]);

    const companies = groupCompanies(companyRows);
    const rows = countFrom(recordedRow, 'rows') ?? 0;
    // Only the amounts are counted, since only they have gaps worth stating; a
    // column with no count of its own is recorded everywhere by definition.
    const columns = [...FINANCIAL_DATA_COLUMNS].map(([name, unit]) =>
      describeColumn(name, unit, countFrom(recordedRow, name) ?? rows),
    );

    return withFingerprint({ companies, columns, rows, years: yearsOf(companies) });
  }
}

interface Grouped {
  readonly company: string;
  readonly ticker: string;
  readonly sector: string;
  readonly years: number[];
}

/** One row per company and year in, one entry per company out. */
function groupCompanies(result: QueryRows): readonly CatalogCompany[] {
  const byCompany = new Map<string, Grouped>();

  for (const [company, ticker, sector, year] of result.rows) {
    if (company === null || company === undefined) continue;

    const entry: Grouped = byCompany.get(company) ?? {
      company,
      ticker: ticker ?? '',
      sector: sector ?? '',
      years: [],
    };
    const parsed = Number(year);
    if (Number.isInteger(parsed)) entry.years.push(parsed);
    byCompany.set(company, entry);
  }

  return [...byCompany.values()].map((entry) => ({
    ...entry,
    years: [...entry.years].sort((left, right) => left - right),
  }));
}

/** Every year some company has. No company is promised all of them. */
function yearsOf(companies: readonly CatalogCompany[]): readonly number[] {
  return [...new Set(companies.flatMap((company) => company.years))].sort(
    (left, right) => left - right,
  );
}

function countFrom(result: QueryRows, column: string): number | null {
  const index = result.columns.indexOf(column);
  const value = index < 0 ? null : (result.rows[0]?.[index] ?? null);
  if (value === null) return null;

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * `usd` is what this application calls a column of money and `money` is what
 * `packages/grounding` calls it. One is about display, the other about what a
 * figure in a sentence may be compared with; the translation lives here so that
 * neither package has to hold the other's word for it.
 */
function describeColumn(name: string, unit: ColumnUnit, recorded: number): CatalogColumn {
  return { name, kind: unit === 'usd' ? 'money' : 'plain', recorded };
}

function withFingerprint(catalog: Omit<SemanticCatalog, 'fingerprint'>): SemanticCatalog {
  const shape = JSON.stringify({
    format: CATALOG_FORMAT,
    rows: catalog.rows,
    years: catalog.years,
    columns: catalog.columns,
    companies: [...catalog.companies].sort((left, right) =>
      left.company.localeCompare(right.company),
    ),
  });

  return { ...catalog, fingerprint: createHash('sha256').update(shape).digest('hex').slice(0, 32) };
}
