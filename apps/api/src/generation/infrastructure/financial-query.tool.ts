import { formatUsd, ratio, roundToInteger } from '@fca/grounding';
import { Inject, Injectable } from '@nestjs/common';

import { CachedFinancialQuery, type QueryReading } from './cached-financial-query';
import { CpuPool } from '../../shared/cpu/cpu-pool';
import { asError } from '../../shared/observability/app-logger';
import type {
  FinancialQueryTool,
  QueryOutcome,
  ToolFailure,
  Truncation,
} from '../application/ports/financial-query.tool.port';
import { SQL_POLICY, type SqlPolicy } from '../application/ports/sql-policy.port';
import { toModelMessage } from '../application/query-outcome';

/**
 * Validate, run, and hand back something the model can answer from.
 *
 * Every failure is a value: the policy refusing, the server refusing, a query
 * that ran out of its three seconds. The model reads the reason and writes
 * another query, which is the loop this tool exists to serve — throwing would
 * end the generation instead, and "that query was not allowed" is not the end of
 * anything.
 */

/**
 * Fifty rows of eight columns is around 2,500 tokens, and a tool result is sent
 * again with every later message in the conversation. This is the ceiling that
 * stops the widest query crowding out the answer to it.
 */
const TOKEN_BUDGET = 1_500;
/** Cut, measure, cut again converges in two passes; three is the ceiling. */
const TRIM_PASSES = 3;
/** Below this a result stops being evidence of anything. */
const MIN_ROWS_SHOWN = 3;

const TRUNCATION_HINT =
  'The result was cut to fit. Aggregate in SQL — sum, avg or count with GROUP BY — or order ' +
  'and take fewer rows, rather than asking for all of them.';

@Injectable()
export class PgFinancialQueryTool implements FinancialQueryTool {
  constructor(
    @Inject(SQL_POLICY) private readonly policy: SqlPolicy,
    private readonly query: CachedFinancialQuery,
    private readonly cpu: CpuPool,
  ) {}

  async execute(toolCallId: string, sql: string): Promise<QueryOutcome> {
    const started = performance.now();

    const plan = this.policy.validate(sql);
    if (!plan.ok) {
      return failed(toolCallId, { kind: plan.error.rule, message: plan.error.message }, started);
    }

    try {
      const reading = await this.query.rows(plan.value.sql);
      const call: Call = { toolCallId, reading, started, usdColumns: plan.value.usdColumns };
      return await this.withinBudget(call);
    } catch (error) {
      return failed(toolCallId, { kind: 'database', message: databaseMessage(error) }, started);
    }
  }

  /**
   * Measured with the real tokenizer rather than estimated from characters, and
   * on the pool that keeps it off the event loop. Estimating is tempting and
   * wrong in the direction that costs money: company names, display strings and
   * long integers do not tokenize like prose.
   */
  private async withinBudget(call: Call): Promise<QueryOutcome> {
    let candidate = outcomeOf(call, call.reading.rows.length, null);

    for (let pass = 0; pass < TRIM_PASSES; pass += 1) {
      // Each pass measures what the last one produced, so they cannot overlap.
      // eslint-disable-next-line no-await-in-loop -- see above
      const tokens = await this.cpu.countTokens(toModelMessage(candidate));
      if (tokens <= TOKEN_BUDGET) return candidate;

      const shown = fewerRows(candidate.rows.length, tokens);
      if (shown >= candidate.rows.length) return candidate;

      candidate = outcomeOf(call, shown, {
        shown,
        total: call.reading.rows.length,
        hint: TRUNCATION_HINT,
      });
    }

    return candidate;
  }
}

interface Call {
  readonly toolCallId: string;
  readonly reading: QueryReading;
  readonly started: number;
  readonly usdColumns: ReadonlySet<string>;
}

function outcomeOf(call: Call, shown: number, truncated: Truncation | null): QueryOutcome {
  const rows = call.reading.rows.slice(0, shown);

  return {
    toolCallId: call.toolCallId,
    columns: call.reading.columns,
    rows,
    display: displayColumns(call.reading.columns, rows, call.usdColumns),
    rowCount: call.reading.rows.length,
    truncated,
    elapsedMs: Math.round(performance.now() - call.started),
    fromCache: call.reading.fromCache,
    failure: null,
  };
}

/**
 * Tokens grow with rows, so measured-over-allowed says roughly how many rows
 * fit. Nine tenths of that, because the header, the note and the display strings
 * are a fixed cost the ratio knows nothing about.
 */
function fewerRows(shown: number, tokens: number): number {
  const fits = Math.floor((shown * TOKEN_BUDGET * 0.9) / tokens);
  return Math.max(MIN_ROWS_SHOWN, Math.min(shown - 1, fits));
}

/**
 * A display string per column that holds an amount — and none at all for a name
 * the result uses twice.
 *
 * The policy refuses a query whose columns would collide, so the second case
 * should be unreachable. It is checked here anyway because this is the only
 * place that sees the names the driver actually returned: whatever the policy
 * worked out from the query, a map keyed by name can hold one entry per name,
 * and the loser would silently become the display string for the winner. The
 * cost of being careful is a missing display string; the cost of being wrong is
 * a figure from the wrong column that verification cannot catch, because the
 * number really is in the results.
 */
function displayColumns(
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
  usdColumns: ReadonlySet<string>,
): ReadonlyMap<string, readonly (string | null)[]> {
  const display = new Map<string, readonly (string | null)[]>();

  columns.forEach((column, index) => {
    const appearsOnce = columns.indexOf(column) === columns.lastIndexOf(column);
    if (!usdColumns.has(column) || !appearsOnce) return;
    display.set(
      column,
      rows.map((row) => usdText(row[index] ?? null)),
    );
  });

  return display;
}

/**
 * The same formatter the finished answer is checked with, which is what makes a
 * figure the model copied supported by definition: the band `$97.0B` stands for
 * is exactly what `packages/grounding` will look for the exact value inside.
 *
 * Rounded here and only here. An `avg()` arrives with eight decimal places and
 * the exact value is what evidence keeps, so rounding belongs where a string is
 * written for a reader and nowhere earlier.
 */
function usdText(value: string | null): string | null {
  if (value === null) return null;

  const parts = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (parts === null) return null;

  const fraction = parts[3] ?? '';
  const numerator = BigInt(`${parts[1] ?? ''}${parts[2] ?? '0'}${fraction}`);
  return formatUsd(roundToInteger(ratio(numerator, 10n ** BigInt(fraction.length))));
}

function failed(toolCallId: string, failure: ToolFailure, started: number): QueryOutcome {
  return {
    toolCallId,
    columns: [],
    rows: [],
    display: new Map(),
    rowCount: 0,
    truncated: null,
    elapsedMs: Math.round(performance.now() - started),
    fromCache: false,
    failure,
  };
}

/**
 * The server's own words. They say whether it was a timeout, a column that does
 * not exist or a permission, and each of those is something the model can do
 * differently — it is the reader here, not a person.
 */
function databaseMessage(error: unknown): string {
  return `The query failed: ${asError(error).message}`;
}
