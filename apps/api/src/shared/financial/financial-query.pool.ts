import { createHash } from 'node:crypto';

import type { AppConfig } from '@fca/config';
import type { CanonicalSql } from '@fca/domain';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { APP_CONFIG } from '../config/app-config.token';
import type { HealthIndicator } from '../health/health-indicator';

/**
 * The connection SQL written by a model runs on, and the second of the three
 * layers that make that safe.
 *
 * It is a different pool from the application's for a reason that has nothing to
 * do with performance: it authenticates as `llm_reader`, a role that holds
 * `SELECT` on one table, is read-only by default, and is cut off after three
 * seconds. Everything the AST policy promises, this role would still enforce if
 * the policy were wrong — and a validator is code, so one day it will be.
 *
 * `query` takes a `CanonicalSql` and there is no overload taking a string, which
 * is how "run this query the model wrote" fails to compile.
 */

const POOL_SIZE = 5;
/** The role's own ceiling is three seconds; this says so from here as well. */
const STATEMENT_TIMEOUT_MS = 3_000;
/** Longer, so the server's own timeout is what usually reports a slow query. */
const QUERY_TIMEOUT_MS = 5_000;
const CONNECTION_TIMEOUT_MS = 3_000;

export interface QueryRows {
  readonly columns: readonly string[];
  /** Row-major and aligned with `columns`. `null` is a value nobody recorded. */
  readonly rows: readonly (readonly (string | null)[])[];
}

/**
 * Every value arrives as text, including the numbers — especially the numbers.
 * A `bigint` past 2^53 and a `numeric` average with eight decimal places both
 * lose digits on the way into a JavaScript number, and those digits are what an
 * answer is checked against: the model has been seen copying
 * `157282577777.77777778` into a sentence word for word, and a figure rounded
 * before it became evidence is a figure with no evidence.
 */
const keepAsText = (value: string): string => value;

@Injectable()
export class FinancialQueryPool implements OnModuleDestroy, HealthIndicator {
  readonly name = 'financial-data';
  private readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.database.financialUrl,
      application_name: 'fca-llm-reader',
      max: POOL_SIZE,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      types: { getTypeParser: () => keepAsText },
    });
  }

  /**
   * No cancellation signal, deliberately. PostgreSQL cancels a running query
   * from a second connection, so honouring one would mean opening another
   * connection as this role to call `pg_cancel_backend` — machinery to avoid
   * waiting out a ceiling that is three seconds away.
   */
  async query(sql: CanonicalSql): Promise<QueryRows> {
    const result = await this.pool.query<unknown[]>({ text: sql.text, rowMode: 'array' });

    return {
      columns: result.fields.map((field) => field.name),
      rows: result.rows.map((row) => row.map(cellText)),
    };
  }

  async check(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Every parser on this pool returns text, so a value is either a string or the
 * `null` the driver puts there for a column nobody filled in. Anything else
 * would be a value no answer could be checked against, and reading it as one
 * would be worse than reading it as missing.
 */
function cellText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * What a query is called in a log line and in the cache. The SQL itself says
 * which company someone asked about, and a log line outlives the reason it was
 * kept — so what is written down is the digest, which is enough to see the same
 * query twice and not enough to read it.
 */
export function queryDigest(sql: CanonicalSql): string {
  return createHash('sha256').update(sql.text).digest('hex').slice(0, 32);
}
