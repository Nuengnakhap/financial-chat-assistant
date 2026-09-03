import { isErr, isOk, type Result } from '@fca/domain';
import { parseSync } from 'pgsql-parser';
import { beforeAll, describe, expect, it } from 'vitest';

import { Counters } from '../../../shared/observability/counters';
import {
  SQL_RULES,
  type QueryPlan,
  type SqlRule,
  type SqlViolation,
} from '../../application/ports/sql-policy.port';
import { CountingSqlPolicy } from '../counting-sql-policy';
import { inspect } from '../pg-ast';
import { PgAstSqlPolicy } from '../pg-ast-sql-policy';
import { ALLOWED_KEYS, MAX_ROWS, MAX_SQL_LENGTH } from '../sql-allowlist';

/**
 * The corpus is the specification. Everything below either runs against the
 * database — one table, read-only, three-second ceiling — or it does not run at
 * all, and which of those a query is has to be decided here rather than by
 * whoever reads the next diff.
 */

const policy = new PgAstSqlPolicy();

beforeAll(async () => {
  // The parser is WebAssembly and its synchronous entry points throw until it is
  // loaded. In the running application the module lifecycle does this.
  await policy.onModuleInit();
});

/**
 * Queries a question about this dataset can legitimately need. Every one of them
 * is also what justifies an entry in the allowlist — see the last test in this
 * file, which fails if a permission has no query behind it.
 */
const MUST_ACCEPT: readonly string[] = [
  "SELECT * FROM financial_data WHERE ticker = 'AAPL'",
  'WITH t AS (SELECT company, year, revenue FROM financial_data) SELECT * FROM t ORDER BY revenue DESC NULLS LAST',
  'SELECT company, sum(revenue) FROM financial_data GROUP BY company ORDER BY 2 DESC LIMIT 10',
  "SELECT year, revenue, lag(revenue) OVER (ORDER BY year) FROM financial_data WHERE ticker = 'AAPL'",
  'SELECT company, round(avg(revenue), 2) AS avg_rev FROM financial_data WHERE year BETWEEN 2022 AND 2025 GROUP BY company HAVING count(*) = 4 ORDER BY avg_rev DESC NULLS LAST LIMIT 5',
  "SELECT company, revenue, coalesce(net_income, 0) FROM financial_data WHERE company IN ('Apple', 'Tesla') AND revenue IS NOT NULL",
  'SELECT a.company, a.revenue - b.revenue AS growth FROM financial_data a JOIN financial_data b ON a.company = b.company AND b.year = a.year - 1 WHERE a.year = 2024',
  'SELECT DISTINCT sector FROM financial_data',
  "SELECT count(*) FROM financial_data WHERE sector = 'Technology'",
  "SELECT company, CASE WHEN net_income > 0 THEN 'profit' ELSE 'loss' END AS status FROM financial_data WHERE year = 2025",
  'SELECT company, revenue FROM financial_data WHERE year = 2024 AND revenue > (SELECT avg(revenue) FROM financial_data WHERE year = 2024)',
  'SELECT sector, count(DISTINCT company) FROM financial_data GROUP BY sector',
  'SELECT * FROM (SELECT company, revenue FROM financial_data WHERE year = 2025) t ORDER BY revenue DESC LIMIT 5',
  'SELECT company, round(revenue / 1000000000.0, 2) AS revenue_billions FROM financial_data WHERE year = 2025',
  'SELECT company, revenue::numeric / nullif(gross_profit, 0) AS ratio FROM financial_data WHERE year = 2024',
  'SELECT company, revenue, row_number() OVER (PARTITION BY sector ORDER BY revenue DESC) AS position FROM financial_data WHERE year = 2025',
  'SELECT * FROM financial_data ORDER BY revenue DESC LIMIT 10 OFFSET 10',
  "SELECT company FROM financial_data WHERE company LIKE 'A%'",
  'SELECT company, revenue FROM financial_data WHERE NOT (revenue IS NULL) AND year <> 2022',
  'SELECT min(year), max(year) FROM financial_data',
  'SELECT company, abs(net_income) FROM financial_data WHERE net_income < 0',
  "SELECT company, revenue FROM financial_data WHERE year = 2025 AND (sector = 'Technology' OR sector = 'Healthcare') ORDER BY revenue DESC",
  'SELECT sector, avg(revenue) FROM financial_data GROUP BY sector HAVING avg(revenue) IS NOT NULL ORDER BY 2 DESC NULLS LAST',
  'SELECT company, lead(revenue) OVER (PARTITION BY company ORDER BY year) - revenue AS delta FROM financial_data',
  'SELECT company, NULL FROM financial_data WHERE ticker IS NULL',
  'SELECT true FROM financial_data LIMIT 1',
  // The parser writes a schema into the tree, so the policy has to have an
  // opinion about one; `public` is where the table is.
  'SELECT company FROM public.financial_data WHERE year = 2022',
  // A trailing semicolon is one statement, and adds `stmt_len` to the tree.
  "SELECT company FROM financial_data WHERE ticker = 'AAPL';",
  "SELECT upper(company) FROM financial_data WHERE lower(sector) = 'technology'",
  // Every one of these was written by the model against the real prompt, and
  // every one of them cost a round when it came back refused.
  "SELECT year, revenue - first_value(revenue) OVER (ORDER BY year) AS growth FROM financial_data WHERE company = 'Apple'",
  "SELECT last_value(revenue) OVER (ORDER BY year) FROM financial_data WHERE company = 'Apple'",
  'SELECT company, power(revenue / 1000000000.0, 0.25) AS compound FROM financial_data',
  'SELECT company, sqrt(revenue) FROM financial_data',
  // A precision and a scale on the cast: the model writes `DECIMAL(20,2)` when
  // it wants to divide two integers without losing the fraction.
  'SELECT cast(revenue AS numeric(20, 2)) / 3 AS third FROM financial_data',
  'SELECT sum(revenue) FILTER (WHERE year = 2024) AS revenue_2024 FROM financial_data',
  // `ONLY` says not to include inherited tables, of which there are none. It is
  // harmless, and refusing it would cost a whole draft to say so.
  'SELECT company FROM ONLY financial_data',
  // The parser writes this one out as `SELECT *`, which is what it means.
  'TABLE financial_data',
];

/**
 * The first twelve were written from the ways a validator is usually got around,
 * before any of this existed. The rest are what the parse trees themselves
 * suggested once they could be read: an unwrapped `intoClause` with no node type
 * to forbid, a schema-qualified catalog table, a set operation whose second arm
 * is another table.
 *
 * Each names the reason it expects, not merely that it fails. A verdict that is
 * right for the wrong reason tells the model to fix the wrong thing.
 */
const MUST_REJECT: readonly (readonly [string, SqlRule])[] = [
  ['DROP TABLE financial_data', 'not_a_select'],
  ['SELECT 1; DELETE FROM financial_data', 'multiple_statements'],
  ['SELECT * FROM users', 'table'],
  ['SELECT * FROM financial_data JOIN users ON true', 'table'],
  ['WITH x AS (SELECT * FROM pg_tables) SELECT * FROM x', 'table'],
  ['SELECT pg_sleep(10) FROM financial_data', 'function'],
  ["SELECT pg_read_file('/etc/passwd') FROM financial_data", 'function'],
  ['SELECT * FROM financial_data FOR UPDATE', 'construct'],
  ['SELECT * INTO t2 FROM financial_data', 'construct'],
  ['SELECT * FROM financial_data /* */; DROP TABLE x --', 'multiple_statements'],
  ['SELECT (SELECT passwordhash FROM users LIMIT 1) FROM financial_data', 'table'],
  // Deliberately left undecided when the corpus was first written, and settled
  // here: it reads no table, so it cannot be an answer about this dataset — and
  // a result made of literals is a way to manufacture evidence for a figure.
  ["SELECT $$'; DROP TABLE x; --$$", 'no_table'],
  ['SELECT 999000000000', 'no_table'],
  ['WITH t AS (SELECT 1 AS revenue) SELECT revenue FROM t', 'no_table'],

  ['INSERT INTO financial_data VALUES (1)', 'not_a_select'],
  ['UPDATE financial_data SET revenue = 0', 'not_a_select'],
  ['COPY financial_data TO STDOUT', 'not_a_select'],
  ['EXPLAIN SELECT * FROM financial_data', 'not_a_select'],
  ['SET statement_timeout = 0', 'not_a_select'],
  // Valid SQL, and rows with no columns in them: nothing anybody can answer from.
  ['SELECT FROM financial_data', 'no_result_columns'],
  ['SELECT', 'no_table'],
  ['SELECT * FROM financial_data UNION SELECT * FROM users', 'construct'],
  ['SELECT * FROM financial_data UNION ALL SELECT * FROM financial_data', 'construct'],
  ['SELECT * FROM pg_catalog.pg_tables', 'table'],
  ['SELECT * FROM generate_series(1, 10)', 'construct'],
  ['SELECT nonexistent_column FROM financial_data', 'column'],
  ['SELECT u.name FROM financial_data u2', 'column'],
  // The column exists and the thing it is qualified by does not, which is the
  // half of the check the case above cannot see fail.
  ['SELECT u.revenue FROM financial_data u2', 'column'],
  // The other half again: the thing qualifying it exists and the column does not.
  ['SELECT a.nope FROM financial_data a', 'column'],
  ['SELECT * FROM financial_data f, users u', 'table'],
  ["SELECT current_setting('is_superuser') FROM financial_data", 'function'],
  ['SELECT xmlelement(name foo) FROM financial_data', 'construct'],
  ["SELECT 'financial_data'::regclass FROM financial_data", 'type'],
  ['SELECT * FROM financial_data WHERE revenue > (SELECT max(revenue) FROM users)', 'table'],
  ['SELECT company FROM financial_data ORDER BY revenue COLLATE "C"', 'construct'],
  ['SELECT array_agg(company) FROM financial_data', 'function'],
  // Refused on purpose rather than by omission: one builds prose out of column
  // values, and the other is a parse node rather than a call, so allowing it
  // would widen the shapes a query may have rather than the functions it uses.
  ["SELECT string_agg(company, ', ') FROM financial_data", 'function'],
  ['SELECT greatest(revenue, net_income) FROM financial_data', 'construct'],
  ['SELECT company FROM financial_data GROUP BY GROUPING SETS ((company))', 'construct'],
  ['SELECT company FROM financial_data WINDOW w AS (ORDER BY year)', 'construct'],
  ['SELECT $1 FROM financial_data', 'construct'],
  ['SELECT company FROM financial_data WHERE EXISTS (SELECT 1 FROM users)', 'table'],
  // Three parts, which is a shape the checks have no name for: refused rather
  // than read as the two-part case with something ignored.
  ['SELECT public.financial_data.revenue FROM financial_data', 'column'],
  // Two columns called `sum`, which nothing downstream can tell apart: the
  // display strings are keyed by name, so one of them cannot be expressed at
  // all, and a figure copied from the survivor finds support in the other
  // column — a wrong answer that verifies.
  ['SELECT sum(revenue), sum(net_income) FROM financial_data', 'duplicate_column'],
  ['SELECT sum(revenue), sum(year) FROM financial_data', 'duplicate_column'],
  ['SELECT company, company FROM financial_data', 'duplicate_column'],
  ['SELECT *, revenue FROM financial_data', 'duplicate_column'],
  [
    'SELECT a.revenue, b.revenue FROM financial_data a JOIN financial_data b ON a.year = b.year',
    'duplicate_column',
  ],
  // The one a star hides: `a.*` brings a `revenue` of its own, so the result has
  // two columns of that name and the second — last year's figure — would have
  // become the display string for the first.
  [
    'SELECT a.*, b.revenue FROM financial_data a JOIN financial_data b ON b.year = a.year - 1',
    'duplicate_column',
  ],
  ['SELECT * FROM financial_data a JOIN financial_data b ON a.year = b.year', 'duplicate_column'],
  ['SELECT * FROM financial_data a, financial_data b', 'duplicate_column'],
  ['SELECT financial_chat.pg_catalog.abs(revenue) FROM financial_data', 'function'],
  ['SELEC company FROM financial_data', 'syntax'],
  ['', 'empty'],
  ['   ', 'empty'],
  // Not empty, and no statement either: the parser hands back nothing at all.
  ['-- what were the revenues', 'empty'],
  [`SELECT company FROM financial_data WHERE company = '${'x'.repeat(MAX_SQL_LENGTH)}'`, 'length'],
];

function accepted(sql: string): QueryPlan {
  const result = policy.validate(sql);
  if (!isOk(result)) throw new Error(`expected to be accepted: ${sql}\n  ${result.error.message}`);
  return result.value;
}

function refused(result: Result<QueryPlan, SqlViolation>): SqlViolation {
  if (!isErr(result)) throw new Error(`expected to be refused: ${result.value.sql.text}`);
  return result.error;
}

describe('the SQL policy', () => {
  it.each(MUST_ACCEPT)('accepts %s', (sql) => {
    expect(accepted(sql).sql.text).toContain('financial_data');
  });

  it.each(MUST_REJECT)('refuses %s as %s', (sql, rule) => {
    expect(refused(policy.validate(sql)).rule).toBe(rule);
  });

  it('says something the model can act on', () => {
    expect(refused(policy.validate('SELECT * FROM users')).message).toContain('financial_data');
    expect(refused(policy.validate('SELECT nope FROM financial_data')).message).toContain(
      'net_income',
    );
    expect(refused(policy.validate('SELECT pg_sleep(1) FROM financial_data')).message).toContain(
      'sum',
    );
  });

  it('executes the deparsed tree and never the text it was given', () => {
    // Semicolons, comments and dollar quoting are all gone: what comes out is
    // written from the tree, so nothing that was hiding in the string survives.
    const plan = accepted('SELECT company /* comment */ FROM financial_data -- trailing\n');

    expect(plan.sql.text).toBe('SELECT company FROM financial_data LIMIT 50');
  });

  it('is a fixed point: the canonical form of the canonical form is itself', () => {
    // Which is what makes it usable as a cache key and as something to log.
    for (const sql of MUST_ACCEPT) {
      const once = accepted(sql).sql.text;
      expect(accepted(once).sql.text).toBe(once);
    }
  });

  it('has a query in the corpus for every reason it can give', () => {
    // A rule with no case behind it is a rule nobody has seen fire, and a
    // message nobody has read.
    const seen = new Set(MUST_REJECT.map(([, rule]) => rule));

    expect(SQL_RULES.filter((rule) => !seen.has(rule))).toEqual([]);
  });
});

describe('the row ceiling', () => {
  it.each([
    ['SELECT company FROM financial_data', 'SELECT company FROM financial_data LIMIT 50'],
    ['SELECT company FROM financial_data LIMIT 10', 'SELECT company FROM financial_data LIMIT 10'],
    [
      'SELECT company FROM financial_data LIMIT 5000',
      'SELECT company FROM financial_data LIMIT 50',
    ],
    ['SELECT company FROM financial_data LIMIT ALL', 'SELECT company FROM financial_data LIMIT 50'],
    [
      'SELECT company FROM financial_data LIMIT 10 + 40',
      'SELECT company FROM financial_data LIMIT 50',
    ],
    [
      'SELECT company FROM financial_data OFFSET 10',
      'SELECT company FROM financial_data LIMIT 50 OFFSET 10',
    ],
  ])('%s becomes %s', (sql, expected) => {
    expect(accepted(sql).sql.text).toBe(expected);
  });

  it.each([
    // Neither is an integer in the tree — one is a string constant, the other a
    // float, since the value is past what an int32 holds — so both are replaced
    // rather than read as a number that happens to look right.
    "SELECT company FROM financial_data LIMIT '20'",
    'SELECT company FROM financial_data LIMIT 9223372036854775807',
  ])('replaces a limit that is not a whole number: %s', (sql) => {
    expect(accepted(sql).sql.text).toBe('SELECT company FROM financial_data LIMIT 50');
  });

  it('leaves a query asking for no rows alone', () => {
    // A zero is missing from the parse tree rather than present as zero, so
    // reading it wrongly turns "no rows" into fifty of them.
    expect(accepted('SELECT company FROM financial_data LIMIT 0').sql.text).toBe(
      'SELECT company FROM financial_data LIMIT 0',
    );
  });

  it('does not touch a limit inside a subquery, because the outer one bounds the result', () => {
    expect(
      accepted('WITH t AS (SELECT company FROM financial_data LIMIT 500) SELECT * FROM t').sql.text,
    ).toContain('LIMIT 500');
  });
});

describe('the columns that hold amounts', () => {
  it.each([
    ['SELECT revenue FROM financial_data', ['revenue']],
    ['SELECT company, year, ticker FROM financial_data', []],
    ['SELECT sum(revenue) FROM financial_data', ['sum']],
    ['SELECT sum(revenue) AS total FROM financial_data', ['total']],
    ['SELECT count(*) FROM financial_data', []],
    ['SELECT round(avg(net_income), 2) AS mean FROM financial_data', ['mean']],
    ['SELECT revenue - net_income AS gap FROM financial_data', ['gap']],
    ['SELECT revenue / 1000000000.0 AS billions FROM financial_data', []],
    ['SELECT coalesce(gross_profit, 0) FROM financial_data', ['coalesce']],
    ['SELECT revenue::numeric FROM financial_data', ['revenue']],
    ['SELECT lag(revenue) OVER (ORDER BY year) FROM financial_data', ['lag']],
    [
      "SELECT first_value(revenue) OVER (ORDER BY year) FROM financial_data WHERE company = 'Apple'",
      ['first_value'],
    ],
    ['SELECT sum(revenue) FILTER (WHERE year = 2024) AS total FROM financial_data', ['total']],
    // The square root of an amount is a number, not an amount.
    ['SELECT sqrt(revenue) FROM financial_data', []],
    ['SELECT power(revenue, 2) FROM financial_data', []],
    ['SELECT year - 1 AS previous FROM financial_data', []],
    ['SELECT row_number() OVER (ORDER BY revenue) AS position FROM financial_data', []],
    ['SELECT upper(company) FROM financial_data', []],
  ])('%s -> %j', (sql, expected) => {
    expect([...accepted(sql).usdColumns].sort()).toEqual(expected);
  });

  it('reads a star as the columns it stands for', () => {
    expect([...accepted('SELECT * FROM financial_data').usdColumns].sort()).toEqual([
      'gross_profit',
      'net_income',
      'operating_income',
      'revenue',
    ]);
  });

  it('says which name is ambiguous, and how to fix it', () => {
    const violation = refused(
      policy.validate('SELECT sum(revenue), sum(net_income) FROM financial_data'),
    );

    expect(violation.message).toContain('`sum`');
    expect(violation.message).toContain('AS');
  });

  it('reads a star over a CTE as what the CTE selected', () => {
    // Not as the columns of the table underneath it. `year AS revenue` puts a
    // fiscal year in a column called `revenue`, and a display string of `$2.0K`
    // against it would find support in the year column and pass verification.
    const renamed = accepted(
      'WITH t AS (SELECT year AS revenue FROM financial_data) SELECT * FROM t',
    );
    const passed = accepted(
      'WITH t AS (SELECT company, revenue FROM financial_data) SELECT * FROM t',
    );

    expect([...renamed.usdColumns]).toEqual([]);
    expect([...passed.usdColumns]).toEqual(['revenue']);
  });

  it('carries a WITH name into a subquery that reads from it', () => {
    // The scope a subquery is resolved against is the one around it, not an
    // empty one: `t` is declared outside and read inside, and the star over the
    // subquery only means anything if the inner star did.
    const nested = accepted(
      'WITH t AS (SELECT company, revenue FROM financial_data) SELECT * FROM (SELECT * FROM t) u',
    );

    expect([...nested.usdColumns]).toEqual(['revenue']);

    // And a subquery that declares names of its own still sees the ones around
    // it, which is what PostgreSQL does and what stops the inner WITH clause
    // from starting from nothing.
    const both = accepted(
      'WITH outer_rows AS (SELECT company, revenue FROM financial_data) ' +
        'SELECT * FROM (WITH inner_rows AS (SELECT * FROM outer_rows) SELECT * FROM inner_rows) u',
    );

    expect([...both.usdColumns]).toEqual(['revenue']);
  });

  it('reads a star over a subselect as what the subselect selected', () => {
    const passed = accepted('SELECT * FROM (SELECT company, revenue FROM financial_data) t');
    const renamed = accepted('SELECT * FROM (SELECT year AS revenue FROM financial_data) t');

    expect([...passed.usdColumns]).toEqual(['revenue']);
    expect([...renamed.usdColumns]).toEqual([]);
  });

  it('resolves a qualified star to the side of the join it names', () => {
    const joined = accepted(
      'SELECT a.* FROM financial_data a JOIN financial_data b ON a.company = b.company',
    );

    expect([...joined.usdColumns].sort()).toEqual([
      'gross_profit',
      'net_income',
      'operating_income',
      'revenue',
    ]);
  });
});

describe('the allowlist', () => {
  it('has nothing in it that no accepted query needs', () => {
    // A permission with no query behind it is a permission nobody has looked at.
    // An empty allowlist makes the walk report every key it sees, which is the
    // census this needs.
    const needed = new Set<string>();
    for (const sql of MUST_ACCEPT) {
      for (const key of inspect(parseSync(sql), new Set()).unknownKeys) needed.add(key);
    }

    expect([...ALLOWED_KEYS].filter((key) => !needed.has(key)).sort()).toEqual([]);
  });

  it('holds the row ceiling the documents agree on', () => {
    expect(MAX_ROWS).toBe(50);
  });
});

/**
 * The wrapper the module actually binds, kept beside the corpus it counts: the
 * port's own docstring asked for a violation to be countable per rule without
 * parsing its message, and until now nothing counted.
 */
describe('counting what was refused', () => {
  const counted = (sql: string): Record<string, number> => {
    const counters = new Counters();
    new CountingSqlPolicy(policy, counters).validate(sql);

    return { ...counters.snapshot() };
  };

  it('names the rule that refused it, not just that something was refused', () => {
    expect(counted('SELECT * FROM users')).toEqual({ 'sql.refused{table}': 1 });
    expect(counted('DELETE FROM financial_data')).toEqual({ 'sql.refused{not_a_select}': 1 });
  });

  it('counts nothing for a query that was allowed', () => {
    expect(counted('SELECT company FROM financial_data')).toEqual({});
  });

  it('hands the verdict back unchanged, whichever it was', () => {
    const wrapped = new CountingSqlPolicy(policy, new Counters());

    expect(wrapped.validate('SELECT * FROM users')).toEqual(policy.validate('SELECT * FROM users'));
    const allowed = wrapped.validate('SELECT company FROM financial_data');
    expect(allowed.ok).toBe(true);
  });
});
