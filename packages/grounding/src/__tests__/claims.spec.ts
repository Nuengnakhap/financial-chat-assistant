import { describe, expect, it } from 'vitest';

import { extractNumericClaims, type NumericLiteral, type Role } from '../claims';

function textsWithRole(markdown: string, role: Role): readonly string[] {
  return extractNumericClaims(markdown)
    .filter((literal) => literal.role === role)
    .map((literal) => literal.text);
}

function only(markdown: string): NumericLiteral {
  const found = extractNumericClaims(markdown);
  if (found.length !== 1) {
    throw new Error(`expected one literal in "${markdown}", found ${String(found.length)}`);
  }

  return (
    found[0] ??
    (() => {
      throw new Error('unreachable');
    })()
  );
}

describe('the traps real answers contained', () => {
  it('reads a year range as two years, not as a subtraction', () => {
    // "Apple vs. Microsoft Revenue, 2022-2025" — a hyphen between digits is a
    // range. Read as a sign it would make the second year a negative figure with
    // no evidence, and every trend answer would be rejected.
    expect(textsWithRole('Revenue, 2022-2025', 'year')).toEqual(['2022', '2025']);
    expect(textsWithRole('Revenue, 2022-2025', 'figure')).toEqual([]);
  });

  it('does not let a sentence comma group digits', () => {
    // "…in 2025, while Microsoft increased…" A comma groups only when exactly
    // three digits follow it.
    expect(only('reaching its highest level in 2025, while Microsoft grew').text).toBe('2025');
    expect(only('revenue of $96,995,000,000 in total').text).toBe('$96,995,000,000');
  });

  it('does not read a parenthesised year as a negative amount', () => {
    // The header "Average revenue (2024)" appeared in a real answer, and
    // accountants write −2.7 as (2.7). Supporting that notation would turn this
    // heading into a claim that the dataset holds minus two thousand and
    // twenty-four — so the notation is simply not supported, since nothing in
    // this system ever produces it.
    const literal = only('| Sector | Average revenue (2024) |');

    expect(literal.text).toBe('2024');
    expect(literal.role).toBe('year');
  });

  it('keeps a full stop that ends a sentence out of the number', () => {
    expect(only('Revenue reached $416.2B.').text).toBe('$416.2B');
  });
});

describe('which numbers are claims about the data', () => {
  it('checks anything carrying a currency marker or a percent sign', () => {
    const markdown = 'Apple earned **$97.0B**, up 12.4% on -$2.7B and 22000000 USD.';

    expect(textsWithRole(markdown, 'figure')).toEqual([
      '$97.0B',
      '12.4%',
      '-$2.7B',
      '22000000 USD',
    ]);
  });

  it('allows a bare year through as structure', () => {
    expect(only('The dataset covers 2023.').role).toBe('year');
  });

  it('reads a year outside coverage as a year, for the report to reject as such', () => {
    // Whether 2019 is in the dataset needs the catalog, which is the verifier's
    // to hold. Calling it a figure here would report the wrong reason for the
    // right refusal.
    expect(only('The dataset covers 2019.').role).toBe('year');
  });

  it('does not let a bare number pass as a year just because it has four digits', () => {
    // 1000–2999 would be the obvious reading of "four digits" and would wave
    // through two thousand bare numbers to buy the two hundred that are years.
    expect(only('Revenue reached 2500 last year.').role).toBe('figure');
    expect(only('It was 1400.').role).toBe('figure');
  });

  it('checks a bare count in prose, because 48 is not 49', () => {
    // The brief says this dataset holds 48 companies. It holds 49, and COUNT(*)
    // puts the real number in the results — so a blanket allowlist for small
    // integers would wave through the one number most likely to be wrong.
    expect(only('The dataset contains **49 companies**.').role).toBe('figure');
    expect(only('The dataset contains **48 companies**.').role).toBe('figure');
  });

  it('allows the rank column of a table, bounded by that table', () => {
    const table = [
      '| Rank | Company | Revenue |',
      '|---:|---|---:|',
      '| 1 | Walmart | $642.6B |',
      '| 2 | Amazon | $638.0B |',
      '| 3 | UnitedHealth | $400.3B |',
    ].join('\n');

    expect(textsWithRole(table, 'rank')).toEqual(['1', '2', '3']);
    expect(textsWithRole(table, 'figure')).toEqual(['$642.6B', '$638.0B', '$400.3B']);
  });

  it('does not extend that allowance past the rows the table has', () => {
    const table = ['| Rank | Company |', '|---|---|', '| 1 | Walmart |', '| 7 | Amazon |'].join(
      '\n',
    );

    expect(textsWithRole(table, 'rank')).toEqual(['1']);
    expect(textsWithRole(table, 'figure')).toEqual(['7']);
  });

  it('does not allow a bare number in any other column of a table', () => {
    const table = ['| Company | Employees |', '|---|---|', '| Walmart | 2 |'].join('\n');

    expect(textsWithRole(table, 'rank')).toEqual([]);
    expect(textsWithRole(table, 'figure')).toEqual(['2']);
  });

  it('does not treat a pipe-free line as a table', () => {
    expect(only('1 of them').role).toBe('figure');
  });
});

describe('where in the answer a figure was written', () => {
  const answer = [
    "Apple's net income in 2023 was **$97.0B**.",
    '',
    '| Year | Net income |',
    '|---|---:|',
    '| 2023 | $97.0B |',
    '',
    '```chart',
    '{"type":"bar","data":[{"year":2023,"net_income":96995000000}]}',
    '```',
  ].join('\n');

  it('separates prose, table and chart', () => {
    const byContext = new Map<string, string[]>();
    for (const literal of extractNumericClaims(answer)) {
      byContext.set(literal.context, [...(byContext.get(literal.context) ?? []), literal.text]);
    }

    expect(byContext.get('prose')).toEqual(['2023', '$97.0B']);
    expect(byContext.get('table')).toEqual(['2023', '$97.0B']);
    expect(byContext.get('chart')).toEqual(['2023', '96995000000']);
  });

  it('still checks a figure inside a fence that is not a chart', () => {
    // A number in a code block is a number the reader sees. Skipping fenced
    // content would leave a hole anything could be written through — and calling
    // it chart data would hand it to the block check, which expects JSON.
    const fenced = ['```', 'net income: $85.2B', '```'].join('\n');

    expect(only(fenced)).toMatchObject({ text: '$85.2B', role: 'figure', context: 'prose' });
  });

  it('points at the offset the literal starts on, so an answer can be reassembled', () => {
    const literal = only('Apple earned $97.0B');

    expect(literal.at).toBe('Apple earned '.length);
  });

  it('reports every literal in the order it was written', () => {
    const found = extractNumericClaims(answer);
    const offsets = found.map((literal) => literal.at);

    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(
      found.map((literal) => answer.slice(literal.at, literal.at + literal.text.length)),
    ).toEqual(found.map((literal) => literal.text));
  });
});
