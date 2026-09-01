import { groundingReport } from '@fca/contracts';
import { describe, expect, it } from 'vitest';

import type { ColumnKind, Coverage } from '../coverage';
import type { ToolResult } from '../tool-result';
import { verify } from '../verify';

/** The projection of the catalog this dataset would produce. */
const coverage: Coverage = {
  years: [2022, 2023, 2024, 2025],
  columns: new Map<string, ColumnKind>([
    ['revenue', 'money'],
    ['net_income', 'money'],
    ['operating_income', 'money'],
    ['gross_profit', 'money'],
    ['year', 'plain'],
  ]),
};

const apple: ToolResult = {
  toolCallId: 'call_1',
  columns: ['company', 'year', 'net_income'],
  rows: [['Apple', '2023', '96995000000']],
};

const nvidia: ToolResult = {
  toolCallId: 'call_2',
  columns: ['year', 'revenue'],
  rows: [
    ['2022', '26914000000'],
    ['2025', '130497000000'],
  ],
};

/** Every report this suite produces goes through the schema both sides read. */
function report(markdown: string, results: readonly ToolResult[] = [apple]) {
  const produced = verify(markdown, results, coverage);

  return groundingReport.parse(produced);
}

describe('the report a verified answer carries', () => {
  it('is the shape `@fca/contracts` declares, parsed by the real schema', () => {
    // Not a structural copy of it: this is the schema the API validates with and
    // the browser reads through, so a field drifting apart fails here first.
    const parsed = report("Apple's net income in 2023 was **$97.0B**.");

    expect(parsed.verdict).toBe('pass');
    expect(parsed.checkedClaims).toEqual([
      {
        text: '$97.0B',
        value: '96995000000',
        toolCallId: 'call_1',
        column: 'net_income',
        rowIndex: 0,
      },
    ]);
  });

  it('carries every claim it checked, not a count of them', () => {
    const parsed = report('Revenue went from **$26.9B** to **$130.5B**.', [nvidia]);

    expect(parsed.checkedClaims).toHaveLength(2);
    expect(parsed.checkedClaims.map((claim) => claim.value)).toEqual([
      '26914000000',
      '130497000000',
    ]);
  });

  it('points at the row the figure was found in, not at the first one', () => {
    // Every other fixture here happens to match row zero, which is exactly how a
    // provenance field ends up hardcoded and nobody notices.
    const twoYears: ToolResult = {
      toolCallId: 'call_7',
      columns: ['year', 'net_income'],
      rows: [
        ['2023', '96995000000'],
        ['2024', '93736000000'],
      ],
    };

    const parsed = report('Net income in 2024 was **$93.7B**.', [twoYears]);

    expect(parsed.checkedClaims).toEqual([
      {
        text: '$93.7B',
        value: '93736000000',
        toolCallId: 'call_7',
        column: 'net_income',
        rowIndex: 1,
      },
    ]);
  });

  it('says nothing was checked when the answer holds no figures', () => {
    const parsed = report('Here is what the dataset covers.');

    expect(parsed).toEqual({ verdict: 'pass', checkedClaims: [], violations: [] });
  });

  it('has nothing to say about an answer written before anything was queried', () => {
    expect(report('Which company would you like?', [])).toEqual({
      verdict: 'pass',
      checkedClaims: [],
      violations: [],
    });
  });

  it('lets how many rows came back be a claim, pointing at the first of them', () => {
    // "The dataset contains 49 companies" is the shape of this, and it is the
    // reason a bare count in prose is checked rather than waved through. A row
    // count belongs to no single row, so it names the one row it is certain of.
    const three: ToolResult = {
      toolCallId: 'call_8',
      columns: ['company'],
      rows: [['Apple'], ['Microsoft'], ['Nvidia']],
    };

    const parsed = report('There are **3** companies in the results.', [three]);

    expect(parsed.verdict).toBe('pass');
    expect(parsed.checkedClaims).toEqual([
      { text: '3', value: '3', toolCallId: 'call_8', column: '(row count)', rowIndex: 0 },
    ]);
  });

  it('refuses a count the results do not have', () => {
    const three: ToolResult = {
      toolCallId: 'call_8',
      columns: ['company'],
      rows: [['Apple'], ['Microsoft'], ['Nvidia']],
    };

    expect(report('There are **48** companies.', [three]).violations).toEqual([
      { text: '48', reason: 'no_evidence' },
    ]);
  });
});

describe('a figure without support', () => {
  it('fails, and names the figure rather than the sentence', () => {
    const parsed = report("Apple's net income in 2023 was **$85.2B**.");

    expect(parsed.verdict).toBe('fail');
    expect(parsed.violations).toEqual([{ text: '$85.2B', reason: 'no_evidence' }]);
  });

  it('is a mismatch when a real value is one string away, and invented otherwise', () => {
    // The difference is what a repair round can act on. "$96.9B" against a table
    // holding 96,995,000,000 is a digit misread and can be corrected; "$85.2B"
    // is near nothing, and asking for an adjustment would invite a second guess.
    expect(report('It was $96.9B.').violations).toEqual([
      { text: '$96.9B', reason: 'value_mismatch' },
    ]);
    expect(report('It was $85.2B.').violations).toEqual([
      { text: '$85.2B', reason: 'no_evidence' },
    ]);
  });

  it('accepts the value at the very edge of the rounding interval', () => {
    const boundary: ToolResult = {
      toolCallId: 'call_3',
      columns: ['gross_profit'],
      rows: [['17450000000']],
    };

    expect(report('Gross profit was $17.4B.', [boundary]).verdict).toBe('pass');
    expect(report('Gross profit was $17.5B.', [boundary]).verdict).toBe('pass');
  });

  it('catches the growth rate the configured model actually invented', () => {
    // "Nvidia's revenue grew from $26.9B in 2022 to $130.5B in 2025, an increase
    // of 300.0%." Two figures right, one wrong, and the prompt rule against
    // mental arithmetic did nothing.
    const parsed = report(
      "Nvidia's revenue grew from **$26.9B in 2022** to **$130.5B in 2025**, an increase of **300.0%**.",
      [nvidia],
    );

    expect(parsed.verdict).toBe('fail');
    expect(parsed.violations).toEqual([{ text: '300.0%', reason: 'no_evidence' }]);
    expect(parsed.checkedClaims).toHaveLength(2);
  });

  it('accepts the growth rate those same rows do imply', () => {
    expect(report('Revenue grew **384.9%** between 2022 and 2025.', [nvidia]).verdict).toBe('pass');
  });
});

describe('the unit a figure is written in', () => {
  it('refuses money that is only supported by something that is not money', () => {
    // 2023 is in the results — as a year. Reading it as an amount would let a
    // fabricated "$2,023" find evidence in the column beside it.
    const parsed = report('The figure was $2,023.');

    expect(parsed.violations).toEqual([{ text: '$2,023', reason: 'unit_mismatch' }]);
  });

  it('refuses a percentage supported only by an amount', () => {
    expect(report('It rose 96995000000%.').violations).toEqual([
      { text: '96995000000%', reason: 'unit_mismatch' },
    ]);
  });

  it('leaves a column it does not recognise alone', () => {
    // An aggregate the model aliased. Claiming a mismatch on a column the
    // catalog never described would be inventing a rule the data cannot support.
    const aliased: ToolResult = {
      toolCallId: 'call_4',
      columns: ['sector', 'average_revenue'],
      rows: [['Consumer', '157282577777.77777778']],
    };

    expect(report('The average was $157.3B.', [aliased]).verdict).toBe('pass');
  });

  it('lets a bare number be supported by anything, which is what a chart holds', () => {
    const parsed = report(
      ['```chart', '{"type":"bar","data":[{"net_income":96995000000}]}', '```'].join('\n'),
    );

    expect(parsed.verdict).toBe('pass');
  });
});

describe('years', () => {
  it('lets a year the dataset holds through without asking for evidence', () => {
    expect(report('The dataset covers 2022 to 2025.').verdict).toBe('pass');
  });

  it('reports a year outside coverage as exactly that', () => {
    const parsed = report('In 2019, net income was $97.0B.');

    expect(parsed.verdict).toBe('fail');
    expect(parsed.violations).toEqual([{ text: '2019', reason: 'out_of_coverage' }]);
    // The figure beside it was still checked, and still passed.
    expect(parsed.checkedClaims).toHaveLength(1);
  });

  it('does not ask a table rank for evidence either', () => {
    const table = [
      '| Rank | Company | Net income |',
      '|---:|---|---:|',
      '| 1 | Apple | $97.0B |',
    ].join('\n');

    expect(report(table).verdict).toBe('pass');
  });
});

describe('claiming the dataset cannot answer', () => {
  it('fails when nothing was ever queried', () => {
    const parsed = report('That data is not available.', []);

    expect(parsed.verdict).toBe('fail');
    expect(parsed.violations).toEqual([{ text: 'not available', reason: 'no_evidence' }]);
  });

  it('passes when a query was run and came back empty', () => {
    // What the configured model did on all four unavailable questions: it asked
    // first, and the empty result is what the sentence rests on.
    const empty: ToolResult = { toolCallId: 'call_5', columns: ['revenue'], rows: [] };

    expect(
      report("Goldman's 2023 revenue is not available in this dataset.", [empty]).verdict,
    ).toBe('pass');
  });

  it('accepts it after a query that failed, and still refuses any figure', () => {
    // A failed call is a result with no columns and no rows, and the caller has
    // to pass it through: dropping it would make "the query failed, so I cannot
    // tell you" indistinguishable from never having asked. The model did look,
    // so the refusal stands — and nothing in an empty result can support a
    // number, so a figure stated anyway still falls.
    const failed: ToolResult = { toolCallId: 'call_10', columns: [], rows: [] };

    expect(report('That data is not available.', [failed]).verdict).toBe('pass');
    expect(report('It was not available, but roughly $45.0B.', [failed]).violations).toEqual([
      { text: '$45.0B', reason: 'no_evidence' },
    ]);
  });

  it('still refuses a figure quoted from an empty result', () => {
    const empty: ToolResult = { toolCallId: 'call_5', columns: ['revenue'], rows: [] };
    const parsed = report('Goldman had revenue of $45.0B in 2023.', [empty]);

    expect(parsed.verdict).toBe('fail');
    expect(parsed.violations).toEqual([{ text: '$45.0B', reason: 'no_evidence' }]);
  });
});

describe('a chart beside a table', () => {
  const withChart = (charted: string, written: string) =>
    [
      `| Year | Net income |`,
      `|---|---:|`,
      `| 2023 | ${written} |`,
      '',
      '```chart',
      `{"type":"bar","xKey":"year","data":[{"year":2023,"net_income":${charted}}]}`,
      '```',
    ].join('\n');

  it('passes when the graph plots what the table says', () => {
    expect(report(withChart('96995000000', '$97.0B')).verdict).toBe('pass');
  });

  it('fails when the graph plots a real value the answer never writes down', () => {
    // Both figures come from the results, so every number is real — but the
    // reader sees one shape and one number, and they are not the same fact.
    const twoRows: ToolResult = {
      toolCallId: 'call_6',
      columns: ['year', 'net_income'],
      rows: [
        ['2023', '96995000000'],
        ['2024', '93736000000'],
      ],
    };
    const parsed = report(withChart('93736000000', '$97.0B'), [twoRows]);

    expect(parsed.verdict).toBe('fail');
    expect(parsed.violations).toEqual([{ text: '93736000000', reason: 'value_mismatch' }]);
  });

  it('reports a fabricated chart value once, as missing evidence', () => {
    // Not twice. A repair round told to fix one figure two different ways is
    // being given a contradiction to resolve.
    const parsed = report(withChart('85200000000', '$97.0B'));

    expect(parsed.violations).toEqual([{ text: '85200000000', reason: 'no_evidence' }]);
  });

  it('says nothing about a chart standing on its own', () => {
    const parsed = report(['```chart', '{"data":[{"net_income":96995000000}]}', '```'].join('\n'));

    expect(parsed.verdict).toBe('pass');
  });
});

describe('a whole answer the configured model actually wrote', () => {
  // An answer the configured model wrote, verbatim, against the rows its own
  // query returned. Prose, a table and a chart at once, with a year range in the
  // chart title and three amounts quoted mid-sentence — every shape the
  // extractor has to get right, in one piece of text nobody wrote to be easy.
  const comparison: ToolResult = {
    toolCallId: 'call_9',
    columns: ['company', 'ticker', 'year', 'revenue'],
    rows: [
      ['Apple', 'AAPL', '2022', '394328000000'],
      ['Microsoft', 'MSFT', '2022', '198270000000'],
      ['Apple', 'AAPL', '2023', '383285000000'],
      ['Microsoft', 'MSFT', '2023', '211915000000'],
      ['Apple', 'AAPL', '2024', '391035000000'],
      ['Microsoft', 'MSFT', '2024', '245122000000'],
      ['Apple', 'AAPL', '2025', '416161000000'],
      ['Microsoft', 'MSFT', '2025', '281724000000'],
    ],
  };

  const answer = [
    '| Year | Apple revenue | Microsoft revenue |',
    '|---|---:|---:|',
    '| 2022 | $394.3B | $198.3B |',
    '| 2023 | $383.3B | $211.9B |',
    '| 2024 | $391.0B | $245.1B |',
    '| 2025 | $416.2B | $281.7B |',
    '',
    'Apple generated higher revenue than Microsoft in every year. Apple’s revenue',
    'dipped in 2023 before reaching $416.2B in 2025, while Microsoft increased each',
    'year from $198.3B to $281.7B.',
    '',
    '```chart',
    '{"type":"line","title":"Apple vs. Microsoft Revenue, 2022-2025","xKey":"year",' +
      '"series":[{"key":"apple","label":"Apple"},{"key":"microsoft","label":"Microsoft"}],' +
      '"data":[{"year":2022,"apple":394328000000,"microsoft":198270000000},' +
      '{"year":2023,"apple":383285000000,"microsoft":211915000000},' +
      '{"year":2024,"apple":391035000000,"microsoft":245122000000},' +
      '{"year":2025,"apple":416161000000,"microsoft":281724000000}]}',
    '```',
  ].join('\n');

  it('passes, with nothing unexplained', () => {
    const parsed = report(answer, [comparison]);

    expect(parsed.violations).toEqual([]);
    expect(parsed.verdict).toBe('pass');
  });

  it('checks the figures rather than merely finding none to check', () => {
    // Eight in the table, three in the prose, eight in the chart. A verifier that
    // silently skipped everything would also report `pass`.
    const parsed = report(answer, [comparison]);

    expect(parsed.checkedClaims).toHaveLength(19);
    expect(parsed.checkedClaims.every((claim) => claim.toolCallId === 'call_9')).toBe(true);
  });

  it('fails the same answer with one digit changed, and says which way', () => {
    // One string out is a misread — $416.3B against 416,161,000,000. Seven
    // strings out is not near anything, and the reason has to say so, or a repair
    // round is told to nudge a figure that was never close.
    const misread = answer.replace('| 2025 | $416.2B |', '| 2025 | $416.3B |');
    const invented = answer.replace('| 2025 | $416.2B |', '| 2025 | $416.9B |');

    expect(report(misread, [comparison]).violations).toEqual([
      { text: '$416.3B', reason: 'value_mismatch' },
    ]);
    expect(report(invented, [comparison]).violations).toEqual([
      { text: '$416.9B', reason: 'no_evidence' },
    ]);
  });
});

describe('more than one query', () => {
  it('attributes each figure to the call that produced it', () => {
    const parsed = report('Apple made $97.0B, and Nvidia grew to $130.5B.', [apple, nvidia]);

    expect(parsed.verdict).toBe('pass');
    expect(parsed.checkedClaims.map((claim) => claim.toolCallId)).toEqual(['call_1', 'call_2']);
  });
});
