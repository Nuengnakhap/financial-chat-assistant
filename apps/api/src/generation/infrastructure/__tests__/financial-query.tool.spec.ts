import type { CanonicalSql } from '@fca/domain';
import { verify, type Coverage } from '@fca/grounding';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CpuPool } from '../../../shared/cpu/cpu-pool';
import type { QueryOutcome } from '../../application/ports/tool-outcome';
import { toEvidence, toModelMessage } from '../../application/query-outcome';
import type { CachedFinancialQuery, QueryReading } from '../cached-financial-query';
import { PgFinancialQueryTool } from '../financial-query.tool';
import { PgAstSqlPolicy } from '../pg-ast-sql-policy';

/**
 * The real policy, because it is pure and fast and a fake one would make every
 * assertion about display strings a statement about the fake. What is faked is
 * the two things that leave the process: the query and the tokenizer.
 */

const policy = new PgAstSqlPolicy();

beforeAll(async () => {
  await policy.onModuleInit();
});

interface FakeQuery {
  readonly service: CachedFinancialQuery;
  reading: QueryReading;
  failWith: Error | null;
  ran: number;
}

function fakeQuery(reading: QueryReading): FakeQuery {
  const fake: FakeQuery = {
    reading,
    failWith: null,
    ran: 0,
    service: {
      rows: async (_sql: CanonicalSql): Promise<QueryReading> => {
        fake.ran += 1;
        if (fake.failWith !== null) throw fake.failWith;
        return await Promise.resolve(fake.reading);
      },
    } as unknown as CachedFinancialQuery,
  };

  return fake;
}

/** Four characters to a token: near enough, and monotone, which is what matters. */
function fakeCpu(): CpuPool {
  return {
    countTokens: async (text: string): Promise<number> =>
      await Promise.resolve(Math.ceil(text.length / 4)),
  } as unknown as CpuPool;
}

const APPLE: QueryReading = {
  columns: ['company', 'year', 'revenue', 'net_income'],
  rows: [
    ['Apple', '2023', '383285000000', '96995000000'],
    ['Apple', '2024', '391035000000', '93736000000'],
  ],
  fromCache: false,
};

let query: FakeQuery;
let tool: PgFinancialQueryTool;

beforeEach(() => {
  query = fakeQuery(APPLE);
  tool = new PgFinancialQueryTool(policy, query.service, fakeCpu());
});

/**
 * The arguments as the model writes them. This tool takes one, called `sql`,
 * and reading it out of the JSON is its own business rather than the runner's —
 * which is what `AgentTool` made true.
 */
function asking(
  tool: PgFinancialQueryTool,
  toolCallId: string,
  sql: string,
): Promise<QueryOutcome> {
  return tool.execute(toolCallId, JSON.stringify({ sql }));
}

describe('the financial query tool', () => {
  it('hands back the rows, the count and a display string per amount', async () => {
    const outcome = await asking(
      tool,
      'call-1',
      'SELECT company, year, revenue, net_income FROM financial_data',
    );

    expect(outcome.failure).toBeNull();
    expect(outcome.columns).toEqual(['company', 'year', 'revenue', 'net_income']);
    expect(outcome.rowCount).toBe(2);
    expect(outcome.truncated).toBeNull();
    expect([...outcome.display.keys()].sort()).toEqual(['net_income', 'revenue']);
    expect(outcome.display.get('revenue')).toEqual(['$383.3B', '$391.0B']);
  });

  it('says nothing about a year or a name, which are not amounts', async () => {
    const outcome = await asking(tool, 'call-1', 'SELECT company, year FROM financial_data');

    expect(outcome.display.size).toBe(0);
  });

  it('leaves a value nobody recorded as nothing', async () => {
    // Not `$0.0`: the model has been measured reading a missing gross profit as
    // zero, and a display string saying so would be handing it the mistake.
    query.reading = {
      columns: ['company', 'gross_profit'],
      rows: [['Amazon', null]],
      fromCache: false,
    };

    const outcome = await asking(
      tool,
      'call-1',
      'SELECT company, gross_profit FROM financial_data',
    );

    expect(outcome.display.get('gross_profit')).toEqual([null]);
    expect(toModelMessage(outcome)).toContain('not recorded');
  });

  it('rounds an average for display and keeps the exact value in the rows', async () => {
    query.reading = {
      columns: ['sector', 'avg'],
      rows: [['Technology', '157282577777.77777778']],
      fromCache: false,
    };

    const outcome = await asking(
      tool,
      'call-1',
      'SELECT sector, avg(revenue) FROM financial_data GROUP BY sector',
    );

    expect(outcome.display.get('avg')).toEqual(['$157.3B']);
    expect(outcome.rows[0]?.[1]).toBe('157282577777.77777778');
  });

  it('refuses what the policy refuses, without running anything', async () => {
    const outcome = await asking(tool, 'call-1', 'SELECT * FROM users');

    expect(outcome.failure?.kind).toBe('table');
    expect(query.ran).toBe(0);
    expect(outcome.columns).toEqual([]);
    expect(outcome.rows).toEqual([]);
  });

  it('still names the statement it refused', async () => {
    // The provenance card a person is shown is built from `sql`, and it is
    // written to `messages.parts` and kept. Leaving it null on this path put
    // the raw arguments — `{"sql":"SELECT * FROM users"}` — on the card and in
    // the row, because the caller has nothing else to fall back to.
    const outcome = await asking(tool, 'call-1', 'SELECT * FROM users');

    expect(outcome.sql).toBe('SELECT * FROM users');
  });

  it('has no statement to name when the arguments were not one', async () => {
    // Nothing was said that could be shown as SQL. Null is the honest answer,
    // and the caller shows what the model actually wrote instead.
    const outcome = await tool.execute('call-1', 'not json at all');

    expect(outcome.failure).not.toBeNull();
    expect(outcome.sql).toBeNull();
  });

  it('turns a server failure into an outcome the model can read', async () => {
    query.failWith = new Error('canceling statement due to statement timeout');

    const outcome = await asking(tool, 'call-1', 'SELECT company FROM financial_data');

    expect(outcome.failure?.kind).toBe('database');
    expect(outcome.failure?.message).toContain('statement timeout');
  });

  it('tells the model an error and nothing that looks like a result', async () => {
    // A result shape beside an error invites reading it as "nothing matched",
    // and answering from memory instead of querying again.
    const outcome = await asking(tool, 'call-1', 'SELECT * FROM users');

    expect(JSON.parse(toModelMessage(outcome))).toEqual({
      error: expect.stringContaining('financial_data'),
    });
  });

  it('says nothing about a name the result uses twice', async () => {
    // The policy refuses a query whose columns would collide, so this result
    // cannot arise through it — which is exactly why it is checked here, on the
    // names the driver actually returned. A map keyed by name holds one entry
    // per name, and the loser would silently become the display string for the
    // winner: `SELECT a.*, b.revenue` would answer this year's question with
    // last year's figure, and the figure is in the results, so verification
    // would accept it.
    query.reading = {
      columns: ['company', 'revenue', 'revenue'],
      rows: [['Apple', '391035000000', '383285000000']],
      fromCache: false,
    };

    const outcome = await asking(tool, 'call-1', 'SELECT company, revenue FROM financial_data');

    expect(outcome.display.size).toBe(0);
    // The rows are still there in full: what is refused is a string that could
    // be read as belonging to either column, not the data.
    expect(outcome.rows[0]?.length).toBe(3);
  });

  it('says whether the answer came from the cache', async () => {
    query.reading = { ...APPLE, fromCache: true };

    expect((await asking(tool, 'call-1', 'SELECT company FROM financial_data')).fromCache).toBe(
      true,
    );
  });
});

describe('the token budget', () => {
  function wideResult(rows: number): QueryReading {
    return {
      columns: [
        'company',
        'ticker',
        'sector',
        'year',
        'revenue',
        'net_income',
        'operating_income',
        'gross_profit',
      ],
      rows: Array.from({ length: rows }, (_, index) => [
        `Company Number ${String(index)}`,
        'TICK',
        'Technology',
        '2024',
        '383285000000',
        '96995000000',
        '114301000000',
        '169148000000',
      ]),
      fromCache: false,
    };
  }

  it('cuts a result that will not fit and says so', async () => {
    query.reading = wideResult(50);

    const outcome = await asking(tool, 'call-1', 'SELECT * FROM financial_data');

    expect(outcome.truncated).not.toBeNull();
    expect(outcome.rows.length).toBe(outcome.truncated?.shown);
    expect(outcome.rows.length).toBeLessThan(50);
    // What the query returned, which is what the model must not describe as all
    // there is.
    expect(outcome.rowCount).toBe(50);
    expect(outcome.truncated?.total).toBe(50);
    expect(outcome.truncated?.hint).toContain('GROUP BY');
  });

  it('cuts to something that fits', async () => {
    query.reading = wideResult(50);

    const outcome = await asking(tool, 'call-1', 'SELECT * FROM financial_data');

    expect(Math.ceil(toModelMessage(outcome).length / 4)).toBeLessThanOrEqual(1_500);
  });

  it('sends a result that cannot be cut small enough anyway', async () => {
    // Three rows is the floor — below that a result stops being evidence of
    // anything — so a result still too large at three rows goes as it is. The
    // context costs what it costs; the alternative is an answer with nothing
    // behind it.
    query.reading = {
      columns: ['company'],
      rows: Array.from({ length: 3 }, () => ['A'.repeat(3_000)]),
      fromCache: false,
    };

    const outcome = await asking(tool, 'call-1', 'SELECT company FROM financial_data');

    expect(outcome.rows.length).toBe(3);
  });

  it('leaves a result that fits alone', async () => {
    query.reading = wideResult(4);

    const outcome = await asking(tool, 'call-1', 'SELECT * FROM financial_data');

    expect(outcome.truncated).toBeNull();
    expect(outcome.rows.length).toBe(4);
  });

  it('builds evidence from the rows that were shown, not the ones that were cut', async () => {
    query.reading = wideResult(50);

    const outcome = await asking(tool, 'call-1', 'SELECT * FROM financial_data');

    expect(toEvidence(outcome).rows.length).toBe(outcome.rows.length);
  });
});

describe('a figure copied from a display string', () => {
  const coverage: Coverage = {
    years: [2022, 2023, 2024, 2025],
    columns: new Map([
      ['company', 'plain'],
      ['year', 'plain'],
      ['revenue', 'money'],
      ['net_income', 'money'],
    ]),
  };

  it('is supported by the result it came from', async () => {
    // The property the whole phase exists for: the tool formats with the same
    // function the finished answer is checked against, so a figure the model
    // copies out of `display` passes verification by construction rather than by
    // luck. If these two ever formatted differently, this test is what says so.
    const outcome = await asking(
      tool,
      'call-1',
      'SELECT company, year, revenue, net_income FROM financial_data',
    );
    const displayed = outcome.display.get('revenue')?.[0];

    const report = verify(
      `Apple's revenue in 2023 was ${String(displayed)}.`,
      [toEvidence(outcome)],
      coverage,
    );

    expect(displayed).toBe('$383.3B');
    expect(report.verdict).toBe('pass');
  });

  it('and a figure that was not in the result is refused', async () => {
    const outcome = await asking(
      tool,
      'call-1',
      'SELECT company, year, revenue, net_income FROM financial_data',
    );

    const report = verify("Apple's revenue in 2023 was $410.0B.", [toEvidence(outcome)], coverage);

    expect(report.verdict).toBe('fail');
  });
});

describe('the tool never throws', () => {
  it('not even when the query object does something unexpected', async () => {
    query.failWith = new Error('socket hang up');
    const outcome = await asking(tool, 'call-1', 'SELECT company FROM financial_data');

    expect(outcome.failure?.kind).toBe('database');
  });

  it('and not when the thing thrown is not an error', async () => {
    const rejecting = {
      rows: async (): Promise<QueryReading> => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a driver that rejects with a string is exactly the case
        return await Promise.reject('nope');
      },
    } as unknown as CachedFinancialQuery;

    const outcome = await asking(
      new PgFinancialQueryTool(policy, rejecting, fakeCpu()),
      'call-1',
      'SELECT company FROM financial_data',
    );

    // Whatever was thrown, the model is told the query failed and what was said.
    expect(outcome.failure?.message).toBe('The query failed: nope');
  });
});
