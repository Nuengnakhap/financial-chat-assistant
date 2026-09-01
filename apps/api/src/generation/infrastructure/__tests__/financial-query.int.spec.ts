import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppConfig } from '@fca/config';
import { expectOk } from '@fca/domain';
import { verify, type Coverage } from '@fca/grounding';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CpuPool } from '../../../shared/cpu/cpu-pool';
import { FinancialQueryPool } from '../../../shared/financial/financial-query.pool';
import type { CachedFinancialQuery } from '../cached-financial-query';
import { FINANCIAL_DATA_COLUMNS, FINANCIAL_DATA_TABLE } from '../financial-data.table';
import { PgFinancialQueryTool } from '../financial-query.tool';
import { PgAstSqlPolicy } from '../pg-ast-sql-policy';

/**
 * The layer under the policy, against a real server.
 *
 * What is proved here cannot be proved anywhere else: that `llm_reader` is a
 * role PostgreSQL itself will refuse to let write, refuse to let read anything
 * but one table, and cut off after three seconds. The AST policy is the first
 * layer and this is the second, and the second one exists precisely because the
 * first is code that could be wrong.
 *
 * The roles and the grants are the files that ship — `infra/init/01-roles.sql`
 * and `data/grant-llm-reader.sql`, read from disk and executed — so a privilege
 * misspelled in either of them fails here rather than in production.
 */

const DATABASE = 'financial_chat';
const REPOSITORY_ROOT = process.cwd().endsWith(join('apps', 'api'))
  ? join(process.cwd(), '..', '..')
  : process.cwd();

interface Connections {
  readonly superuser: string;
  readonly owner: string;
  readonly reader: string;
}

function connections(): Connections {
  const base = process.env['TEST_DATABASE_URL'];
  if (base === undefined) {
    throw new Error('TEST_DATABASE_URL is not set; the integration global setup did not run');
  }

  const as = (user: string, password: string, database: string): string => {
    const url = new URL(base);
    url.username = user;
    url.password = password;
    url.pathname = `/${database}`;
    return url.toString();
  };

  return {
    superuser: base,
    owner: as('app', 'app_password', DATABASE),
    reader: as('llm_reader', 'llm_reader_password', DATABASE),
  };
}

async function run(connectionString: string, statements: readonly string[]): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    // In order, because each one depends on the last having happened.
    // eslint-disable-next-line no-await-in-loop -- see above
    for (const statement of statements) await pool.query(statement);
  } finally {
    await pool.end();
  }
}

function shippedSql(...parts: readonly string[]): string {
  return readFileSync(join(REPOSITORY_ROOT, ...parts), 'utf8');
}

/** The `CREATE TABLE` from the seed dump, so the shape here is the shape shipped. */
function tableDefinition(): string {
  const dump = shippedSql('data', 'financial_data.sql');
  const start = dump.indexOf('CREATE TABLE');
  const end = dump.indexOf(');', start);
  if (start < 0 || end < 0) throw new Error('the seed dump has no CREATE TABLE in it');
  return dump.slice(start, end + 2);
}

const ROWS: readonly (readonly [
  string,
  string,
  string,
  number,
  number,
  number,
  number,
  number | null,
])[] = [
  ['Apple', 'AAPL', 'Technology', 2023, 383285000000, 96995000000, 114301000000, 169148000000],
  ['Apple', 'AAPL', 'Technology', 2024, 391035000000, 93736000000, 123216000000, 180683000000],
  ['AbbVie', 'ABBV', 'Healthcare', 2024, 56334000000, -22000000, 9137000000, 10706000000],
  ['Amazon', 'AMZN', 'Technology', 2024, 637959000000, 59248000000, 68593000000, null],
];

let pool: FinancialQueryPool;
const policy = new PgAstSqlPolicy();

beforeAll(async () => {
  const where = connections();
  await policy.onModuleInit();

  // A database of its own, named as the init file names it, so that file can be
  // executed exactly as written.
  await run(where.superuser, [
    `DROP DATABASE IF EXISTS ${DATABASE}`,
    'DROP ROLE IF EXISTS llm_reader',
    'DROP ROLE IF EXISTS app_runtime',
    'DROP ROLE IF EXISTS app',
    "CREATE ROLE app LOGIN PASSWORD 'app_password'",
    `CREATE DATABASE ${DATABASE} OWNER app`,
  ]);

  const asSuperuser = new URL(where.superuser);
  asSuperuser.pathname = `/${DATABASE}`;
  await run(asSuperuser.toString(), [shippedSql('infra', 'init', '01-roles.sql')]);

  await run(where.owner, [
    tableDefinition(),
    // Something else to be refused: a table the role has no grant on.
    'CREATE TABLE secrets (token TEXT NOT NULL)',
    "INSERT INTO secrets VALUES ('nobody should read this')",
    ...ROWS.map(
      (row) =>
        `INSERT INTO ${FINANCIAL_DATA_TABLE} VALUES (${row
          .map((value) =>
            value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value}'`,
          )
          .join(', ')})`,
    ),
    // Sixty rows in total, so the row ceiling has something to cut.
    `INSERT INTO ${FINANCIAL_DATA_TABLE} SELECT 'Filler ' || g, 'FILL', 'Other', 2022, g, g, g, g FROM generate_series(1, 56) AS g`,
    shippedSql('data', 'grant-llm-reader.sql'),
  ]);

  pool = new FinancialQueryPool({ database: { financialUrl: where.reader } } as AppConfig);
});

afterAll(async () => {
  await pool.onModuleDestroy();
});

async function readRows(sql: string): Promise<readonly (readonly (string | null)[])[]> {
  return (await pool.query(expectOk(policy.validate(sql), 'the policy refused a fixture').sql))
    .rows;
}

describe('the table this system is about', () => {
  it('is the table the policy allows columns from', async () => {
    // The column list is a policy and lives in the source; this is what stops it
    // being a policy about a table that has moved on.
    const reader = new Pool({ connectionString: connections().reader, max: 1 });
    try {
      const found = await reader.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = $1 ORDER BY ordinal_position`,
        [FINANCIAL_DATA_TABLE],
      );

      expect(found.rows.map((row) => row.column_name)).toEqual([...FINANCIAL_DATA_COLUMNS.keys()]);
    } finally {
      await reader.end();
    }
  });
});

describe('readiness', () => {
  it('reports the connection as usable', async () => {
    // What the health probe asks. It is a `SELECT 1` and it still proves the
    // credentials, the database and the connection limit.
    await expect(pool.check()).resolves.toBeUndefined();
  });
});

describe('what the role will not do', () => {
  it('refuses to write, because the role is read-only', async () => {
    const reader = new Pool({ connectionString: connections().reader, max: 1 });
    try {
      await expect(
        reader.query(
          `INSERT INTO ${FINANCIAL_DATA_TABLE} VALUES ('X', 'X', 'X', 2024, 1, 1, 1, 1)`,
        ),
      ).rejects.toThrow(/read-only transaction/u);
    } finally {
      await reader.end();
    }
  });

  it('refuses to read any other table, because it was granted one', async () => {
    const reader = new Pool({ connectionString: connections().reader, max: 1 });
    try {
      await expect(reader.query('SELECT token FROM secrets')).rejects.toThrow(/permission denied/u);
    } finally {
      await reader.end();
    }
  });

  it('cuts off a query that will not finish', async () => {
    // The policy would never pass this one; the point is that the server stops
    // it anyway, which is what the role is for.
    const reader = new Pool({ connectionString: connections().reader, max: 1 });
    try {
      await expect(reader.query('SELECT pg_sleep(10)')).rejects.toThrow(/statement timeout/u);
    } finally {
      await reader.end();
    }
  }, 20_000);
});

describe('reading through the pool', () => {
  it('brings back every number as text, with all of its digits', async () => {
    const rows = await readRows(
      `SELECT company, revenue FROM ${FINANCIAL_DATA_TABLE} WHERE ticker = 'AAPL' AND year = 2024`,
    );

    // 391035000000 survives as itself. As a JavaScript number it would still be
    // exact; as an `avg()` below, it would not.
    expect(rows).toEqual([['Apple', '391035000000']]);
  });

  it('keeps the decimals of an average, which is where rounding would show', async () => {
    const rows = await readRows(
      `SELECT avg(revenue) FROM ${FINANCIAL_DATA_TABLE} WHERE ticker = 'AAPL'`,
    );

    // Eight decimal places, which is what `avg()` over a `bigint` returns —
    // digits a JavaScript number would round away, and the model has been seen
    // copying them into a sentence one at a time.
    expect(rows[0]?.[0]).toBe('387160000000.00000000');
  });

  it('brings back a value nobody recorded as nothing at all', async () => {
    const rows = await readRows(
      `SELECT gross_profit FROM ${FINANCIAL_DATA_TABLE} WHERE ticker = 'AMZN'`,
    );

    expect(rows).toEqual([[null]]);
  });

  it('brings back a negative as a negative', async () => {
    const rows = await readRows(
      `SELECT net_income FROM ${FINANCIAL_DATA_TABLE} WHERE ticker = 'ABBV'`,
    );

    expect(rows).toEqual([['-22000000']]);
  });

  it('stops at the row ceiling the policy wrote into the query', async () => {
    const rows = await readRows(`SELECT * FROM ${FINANCIAL_DATA_TABLE}`);

    expect(rows.length).toBe(50);
  });
});

describe('the tool, end to end', () => {
  const countCharacters = {
    countTokens: async (text: string): Promise<number> =>
      await Promise.resolve(Math.ceil(text.length / 4)),
  } as unknown as CpuPool;

  function toolOn(): PgFinancialQueryTool {
    const query = {
      rows: async (sql: Parameters<FinancialQueryPool['query']>[0]) => ({
        ...(await pool.query(sql)),
        fromCache: false,
      }),
    } as unknown as CachedFinancialQuery;

    return new PgFinancialQueryTool(policy, query, countCharacters);
  }

  it('answers a real question with figures an answer can be checked against', async () => {
    const coverage: Coverage = {
      years: [2022, 2023, 2024, 2025],
      columns: new Map([
        ['company', 'plain'],
        ['revenue', 'money'],
      ]),
    };

    const outcome = await toolOn().execute(
      'call-1',
      `SELECT company, revenue FROM ${FINANCIAL_DATA_TABLE} WHERE ticker = 'AAPL' AND year = 2024`,
    );

    expect(outcome.display.get('revenue')).toEqual(['$391.0B']);
    expect(
      verify(
        "Apple's revenue in 2024 was $391.0B.",
        [{ toolCallId: 'call-1', columns: [...outcome.columns], rows: outcome.rows }],
        coverage,
      ).verdict,
    ).toBe('pass');
  });

  it('hands back what the server said when the server refuses', async () => {
    // Allowed by the policy, rejected by PostgreSQL: a year is an integer.
    const outcome = await toolOn().execute(
      'call-1',
      `SELECT company FROM ${FINANCIAL_DATA_TABLE} WHERE year = 'not a year'`,
    );

    expect(outcome.failure?.kind).toBe('database');
    expect(outcome.failure?.message).toContain('invalid input syntax');
  });

  it('is cut off by the role when a query it allowed runs long', async () => {
    // A cross join of the table with itself, ordered — allowed by the policy,
    // and stopped by the three-second ceiling rather than by anything here.
    const outcome = await toolOn().execute(
      'call-1',
      `SELECT count(*) FROM ${FINANCIAL_DATA_TABLE} a JOIN ${FINANCIAL_DATA_TABLE} b ON a.year > 0 JOIN ${FINANCIAL_DATA_TABLE} c ON c.year > 0 JOIN ${FINANCIAL_DATA_TABLE} d ON d.year > 0 JOIN ${FINANCIAL_DATA_TABLE} e ON e.year > 0`,
    );

    expect(outcome.failure?.kind).toBe('database');
    expect(outcome.failure?.message).toContain('statement timeout');
  }, 20_000);
});
