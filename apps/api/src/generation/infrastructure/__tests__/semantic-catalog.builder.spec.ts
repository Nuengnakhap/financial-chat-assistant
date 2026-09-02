import { describe, expect, it } from 'vitest';

import type { FinancialQueryPool, QueryRows } from '../../../shared/financial/financial-query.pool';
import { SemanticCatalogBuilder } from '../semantic-catalog.builder';

/**
 * What the builder makes of what the table says.
 *
 * The queries themselves are proved against a real server in
 * `semantic-catalog.int.spec.ts`; here the rows are given, and what is under
 * test is the reading of them — which company has which years, what a fingerprint
 * covers, and what happens when a row is not the shape this expects.
 */

const COMPANIES: QueryRows = {
  columns: ['company', 'ticker', 'sector', 'year'],
  rows: [
    ['Apple', 'AAPL', 'Technology', '2023'],
    ['Apple', 'AAPL', 'Technology', '2024'],
    ['BlackRock', 'BLK', 'Finance', '2022'],
  ],
};

const RECORDED: QueryRows = {
  columns: ['rows', 'revenue', 'net_income', 'operating_income', 'gross_profit'],
  rows: [['192', '179', '188', '116', '58']],
};

function builderFor(companies: QueryRows, recorded: QueryRows = RECORDED): SemanticCatalogBuilder {
  const pool = {
    readCatalog: async (read: 'companies' | 'recorded'): Promise<QueryRows> =>
      await Promise.resolve(read === 'companies' ? companies : recorded),
  } as unknown as FinancialQueryPool;

  return new SemanticCatalogBuilder(pool);
}

describe('building the catalog', () => {
  it('gives every company the years it actually has', async () => {
    const catalog = await builderFor(COMPANIES).build();

    expect(catalog.companies).toEqual([
      { company: 'Apple', ticker: 'AAPL', sector: 'Technology', years: [2023, 2024] },
      { company: 'BlackRock', ticker: 'BLK', sector: 'Finance', years: [2022] },
    ]);
  });

  it('collects the years anyone has, without promising them to everyone', async () => {
    // What the verifier is handed: a year outside this set cannot be in an
    // answer at all, while a year inside it may still be missing for a company.
    const catalog = await builderFor(COMPANIES).build();

    expect(catalog.years).toEqual([2022, 2023, 2024]);
  });

  it('counts how much of each amount is recorded, and translates the units', async () => {
    const catalog = await builderFor(COMPANIES).build();

    expect(catalog.rows).toBe(192);
    expect(catalog.columns).toEqual([
      { name: 'company', kind: 'plain', recorded: 192 },
      { name: 'ticker', kind: 'plain', recorded: 192 },
      { name: 'sector', kind: 'plain', recorded: 192 },
      { name: 'year', kind: 'plain', recorded: 192 },
      { name: 'revenue', kind: 'money', recorded: 179 },
      { name: 'net_income', kind: 'money', recorded: 188 },
      { name: 'operating_income', kind: 'money', recorded: 116 },
      { name: 'gross_profit', kind: 'money', recorded: 58 },
    ]);
  });

  it('fingerprints the data rather than the order it arrived in', async () => {
    // The fingerprint decides whether the prompt prefix is byte-identical, so a
    // database returning the same rows in another order must not look like new
    // data — that would throw away the provider's cache for nothing.
    const reversed: QueryRows = { ...COMPANIES, rows: [...COMPANIES.rows].reverse() };

    const first = await builderFor(COMPANIES).build();
    const second = await builderFor(reversed).build();

    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('fingerprints differently when the data differs', async () => {
    const withoutBlackRock: QueryRows = {
      ...COMPANIES,
      rows: COMPANIES.rows.filter((row) => row[0] !== 'BlackRock'),
    };

    const first = await builderFor(COMPANIES).build();
    const second = await builderFor(withoutBlackRock).build();

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('fingerprints differently when a column becomes emptier', async () => {
    // A count nobody looks at would still change the sentence in the prompt.
    const fewer: QueryRows = { ...RECORDED, rows: [['192', '179', '188', '116', '57']] };

    const first = await builderFor(COMPANIES).build();
    const second = await builderFor(COMPANIES, fewer).build();

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it.each([
    ['a row with no company in it', { ...COMPANIES, rows: [[null, 'X', 'X', '2024']] }],
    [
      'a year that is not a year',
      { ...COMPANIES, rows: [['Apple', 'AAPL', 'Technology', 'soon']] },
    ],
  ])('skips %s rather than inventing one', async (_case, rows) => {
    const catalog = await builderFor(rows).build();

    expect(catalog.years).toEqual([]);
  });

  it('reads a company with no ticker or sector as one with neither', async () => {
    const sparse: QueryRows = { ...COMPANIES, rows: [['Apple', null, null, '2024']] };

    const catalog = await builderFor(sparse).build();

    expect(catalog.companies).toEqual([
      { company: 'Apple', ticker: '', sector: '', years: [2024] },
    ]);
  });

  it('reads a count that is not a number as no count at all', async () => {
    const strange: QueryRows = { ...RECORDED, rows: [['many', '179', '188', '116', '58']] };

    const catalog = await builderFor(COMPANIES, strange).build();

    // No total to compare against, so the prompt would say "recorded in 179 of
    // 0 rows" — odd, but not a lie, and not a crash on the way to the model.
    expect(catalog.rows).toBe(0);
  });

  it('reads an empty table as an empty catalog', async () => {
    const nothing: QueryRows = { columns: COMPANIES.columns, rows: [] };
    const noCounts: QueryRows = { columns: RECORDED.columns, rows: [] };

    const catalog = await builderFor(nothing, noCounts).build();

    expect(catalog.companies).toEqual([]);
    expect(catalog.rows).toBe(0);
    expect(catalog.columns.every((column) => column.recorded === 0)).toBe(true);
  });
});
