import { Writable } from 'node:stream';

import { type CanonicalSql, expectOk } from '@fca/domain';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LayeredCache } from '../../../shared/cache/layered-cache';
import type { FinancialQueryPool, QueryRows } from '../../../shared/financial/financial-query.pool';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { CachedFinancialQuery } from '../cached-financial-query';
import { PgAstSqlPolicy } from '../pg-ast-sql-policy';

/**
 * What this layer owes the operator.
 *
 * The tool turns every failure into a value for the model to work with, which
 * leaves nobody to notice that a grant is missing or that queries are timing
 * out — readiness sees neither, because `SELECT 1` still answers. So the line
 * that says so is written here, and this is the test that it is.
 */

const APPLE: QueryRows = { columns: ['company'], rows: [['Apple']] };

function capturing(): { readonly logger: AppLogger; lines: () => readonly LogLine[] } {
  const written: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      done();
    },
  });

  return {
    logger: new AppLogger(createPinoLogger({ level: 'debug', pretty: false, destination })),
    lines: () =>
      written
        .join('')
        .trim()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as LogLine),
  };
}

interface LogLine {
  readonly msg?: string;
  readonly level?: number;
  readonly sqlDigest?: string;
  readonly rows?: number;
  readonly durationMs?: number;
  readonly err?: { readonly message?: string };
}

const policy = new PgAstSqlPolicy();
let sql: CanonicalSql;

beforeAll(async () => {
  await policy.onModuleInit();
  sql = expectOk(
    policy.validate("SELECT company FROM financial_data WHERE ticker = 'AAPL'"),
    'the fixture query was refused',
  ).sql;
});

/** Runs the loader every time, so the cache is not what is under test here. */
const passThroughCache = {
  get: async <T>(_slot: unknown, load: () => Promise<T>): Promise<T> => await load(),
} as unknown as LayeredCache;

function poolThat(answer: QueryRows | Error): FinancialQueryPool {
  return {
    query: async (): Promise<QueryRows> => {
      if (answer instanceof Error) throw answer;
      return await Promise.resolve(answer);
    },
  } as unknown as FinancialQueryPool;
}

let capture: ReturnType<typeof capturing>;

beforeEach(() => {
  capture = capturing();
});

describe('reading a query', () => {
  it('says how long it took and how much came back, by digest', async () => {
    const query = new CachedFinancialQuery(poolThat(APPLE), passThroughCache, capture.logger);

    expect(await query.rows(sql)).toEqual({ ...APPLE, fromCache: false });

    const [line] = capture.lines();
    expect(line?.msg).toBe('financial query read');
    expect(line?.rows).toBe(1);
    expect(line?.durationMs).toBeGreaterThanOrEqual(0);
    // A digest, not the statement: a log line outlives the reason it was kept,
    // and the SQL says which company somebody asked about.
    expect(line?.sqlDigest).toMatch(/^[0-9a-f]{32}$/u);
    expect(JSON.stringify(capture.lines())).not.toContain('AAPL');
  });

  it('warns when the server refuses, and still lets the failure through', async () => {
    const query = new CachedFinancialQuery(
      poolThat(new Error('canceling statement due to statement timeout')),
      passThroughCache,
      capture.logger,
    );

    await expect(query.rows(sql)).rejects.toThrow('statement timeout');

    const [line] = capture.lines();
    expect(line?.msg).toBe('financial query failed');
    // A warning rather than a debug line: a query that will not run is a fault
    // somewhere, and the caller is about to hide it from everyone but the model.
    expect(line?.level).toBe(40);
    expect(line?.sqlDigest).toMatch(/^[0-9a-f]{32}$/u);
    expect(line?.err?.message).toContain('statement timeout');
  });

  it('says when the answer came from the cache rather than the server', async () => {
    const cached = {
      get: async <T>(_slot: unknown, _load: () => Promise<T>): Promise<T> =>
        await Promise.resolve({ ...APPLE } as T),
    } as unknown as LayeredCache;

    const query = new CachedFinancialQuery(
      poolThat(new Error('the pool must not be reached')),
      cached,
      capture.logger,
    );

    expect((await query.rows(sql)).fromCache).toBe(true);
  });
});
