import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppConfig } from '@fca/config';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FinancialQueryPool } from '../../../shared/financial/financial-query.pool';
import { renderSystemPrompt } from '../../application/prompt.factory';
import { coverageOf } from '../../application/semantic-catalog';
import { SemanticCatalogBuilder } from '../semantic-catalog.builder';

/**
 * The catalog against a real table, because the two queries behind it are the
 * one part of this that a fake cannot get wrong on purpose: a column renamed, a
 * `count()` that counts the wrong thing, a year read as text.
 *
 * The rows here are a small stand-in for the shipped dump, chosen for the shapes
 * that matter — a company with fewer years than the rest, a column with gaps,
 * and a name with an apostrophe in it.
 */

const DATABASE = 'financial_catalog_test';
const REPOSITORY_ROOT = process.cwd().endsWith(join('apps', 'api'))
  ? join(process.cwd(), '..', '..')
  : process.cwd();

function connection(database: string): string {
  const base = process.env['TEST_DATABASE_URL'];
  if (base === undefined) {
    throw new Error('TEST_DATABASE_URL is not set; the integration global setup did not run');
  }

  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function tableDefinition(): string {
  const dump = readFileSync(join(REPOSITORY_ROOT, 'data', 'financial_data.sql'), 'utf8');
  const start = dump.indexOf('CREATE TABLE');
  const end = dump.indexOf(');', start);
  return dump.slice(start, end + 2);
}

const ROWS = [
  ['Apple', 'AAPL', 'Technology', 2023, 383285000000, 96995000000, 114301000000, 169148000000],
  ['Apple', 'AAPL', 'Technology', 2024, 391035000000, 93736000000, 123216000000, 180683000000],
  // Two years rather than the others' four, which is why the prompt lists years
  // per company instead of announcing a range.
  ['BlackRock', 'BLK', 'Finance', 2023, 17859000000, 5502000000, 7000000000, null],
  // An apostrophe that has to survive into the prompt and back out into SQL.
  ["McDonald's", 'MCD', 'Consumer', 2023, 25493000000, 8469000000, 11647000000, null],
  ["McDonald's", 'MCD', 'Consumer', 2024, 25920000000, 8223000000, 11710000000, null],
];

let pool: FinancialQueryPool;
let builder: SemanticCatalogBuilder;

beforeAll(async () => {
  const admin = new Pool({ connectionString: connection('postgres'), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
  } finally {
    await admin.end();
  }

  const seed = new Pool({ connectionString: connection(DATABASE), max: 1 });
  try {
    await seed.query(tableDefinition());
    for (const row of ROWS) {
      // eslint-disable-next-line no-await-in-loop -- five rows, in order, once
      await seed.query('INSERT INTO financial_data VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', row);
    }
  } finally {
    await seed.end();
  }

  pool = new FinancialQueryPool({
    database: { financialUrl: connection(DATABASE) },
  } as AppConfig);
  builder = new SemanticCatalogBuilder(pool);
});

afterAll(async () => {
  await pool.onModuleDestroy();
});

describe('the catalog, read from a real table', () => {
  it('finds each company with the years it has', async () => {
    const catalog = await builder.build();

    expect(catalog.companies).toEqual([
      { company: 'Apple', ticker: 'AAPL', sector: 'Technology', years: [2023, 2024] },
      { company: 'BlackRock', ticker: 'BLK', sector: 'Finance', years: [2023] },
      { company: "McDonald's", ticker: 'MCD', sector: 'Consumer', years: [2023, 2024] },
    ]);
  });

  it('counts the gaps in each amount', async () => {
    const catalog = await builder.build();
    const recorded = new Map(catalog.columns.map((column) => [column.name, column.recorded]));

    expect(catalog.rows).toBe(5);
    expect(recorded.get('revenue')).toBe(5);
    // Three rows have no gross profit recorded, which is the sentence the
    // prompt carries and the reason it says to read the result rather than assume.
    expect(recorded.get('gross_profit')).toBe(2);
  });

  it('reads the years as numbers, from a column of text', async () => {
    // Everything comes off this connection as text, so a year is a string until
    // this says otherwise — and the verifier compares years as numbers.
    const catalog = await builder.build();

    expect(catalog.years).toEqual([2023, 2024]);
    expect(coverageOf(catalog).years).toEqual([2023, 2024]);
  });

  it('fingerprints the same data the same way twice', async () => {
    const [first, second] = await Promise.all([builder.build(), builder.build()]);

    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('renders a prompt that spells the table back', async () => {
    const prompt = renderSystemPrompt(await builder.build());

    expect(prompt).toContain("- McDonald's (MCD, Consumer) — 2023, 2024");
    expect(prompt).toContain('- BlackRock (BLK, Finance) — 2023');
    expect(prompt).toContain('- gross_profit: recorded in 2 of 5 rows');
  });

  it('notices the dataset changing under it', async () => {
    const before = await builder.build();
    const writer = new Pool({ connectionString: connection(DATABASE), max: 1 });
    try {
      await writer.query(
        "INSERT INTO financial_data VALUES ('Shopify', 'SHOP', 'Technology', 2025, 1, 1, 1, 1)",
      );
    } finally {
      await writer.end();
    }

    const after = await builder.build();

    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.years).toEqual([2023, 2024, 2025]);
  });
});
