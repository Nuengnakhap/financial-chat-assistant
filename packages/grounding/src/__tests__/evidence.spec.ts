import { describe, expect, it } from 'vitest';

import { bandOf, readNumeric } from '../display';
import { buildEvidenceSet, type EvidenceSet } from '../evidence';
import { roundToInteger, toApproximateNumber } from '../quantity';
import type { ToolResult } from '../tool-result';

function bandFor(text: string) {
  const reading = readNumeric(text);
  if (reading === null) throw new Error(`"${text}" is not a numeric literal`);

  return bandOf(reading);
}

function match(evidence: EvidenceSet, text: string) {
  return evidence.match(bandFor(text));
}

function supports(evidence: EvidenceSet, text: string): boolean {
  return match(evidence, text).length > 0;
}

const apple: ToolResult = {
  toolCallId: 'call_1',
  columns: ['company', 'year', 'net_income'],
  rows: [['Apple', '2023', '96995000000']],
};

/** The two rows behind the answer the configured model got wrong. */
const nvidia: ToolResult = {
  toolCallId: 'call_2',
  columns: ['year', 'revenue'],
  rows: [
    ['2022', '26914000000'],
    ['2025', '130497000000'],
  ],
};

describe('what a query result proves', () => {
  it('supports a figure copied from a cell', () => {
    const evidence = buildEvidenceSet([apple]);

    expect(supports(evidence, '$97.0B')).toBe(true);
    expect(supports(evidence, '$96,995,000,000')).toBe(true);
  });

  it('refuses a figure that is merely close', () => {
    const evidence = buildEvidenceSet([apple]);

    expect(supports(evidence, '$96.9B')).toBe(false);
    expect(supports(evidence, '$85.2B')).toBe(false);
  });

  it('names where the figure was found rather than answering yes', () => {
    const [support] = match(buildEvidenceSet([apple]), '$97.0B');

    expect(support).toMatchObject({
      toolCallId: 'call_1',
      column: 'net_income',
      rows: [0],
      origin: 'cell',
    });
  });

  it('returns every cell a display string could have come from', () => {
    // Measured on the real table: 101 of 396 distinct strings are produced by
    // more than one value, and these three are one of them. A `boolean` here
    // would force the report to invent a row it cannot know.
    const crowded: ToolResult = {
      toolCallId: 'call_3',
      columns: ['company', 'value'],
      rows: [
        ['AMD', '10603000000'],
        ['Coca-Cola', '10631000000'],
        ['Eli Lilly', '10590000000'],
      ],
    };

    const found = match(buildEvidenceSet([crowded]), '$10.6B');

    expect(found.filter((support) => support.origin === 'cell')).toHaveLength(3);
    expect(found.map((support) => support.rows[0])).toEqual(expect.arrayContaining([0, 1, 2]));
  });

  it('puts the nearest of them first, so provenance is not biased to the low end', () => {
    // `$10.6B` denotes 10,600,000,000. AMD is 3,000,000 away, Eli Lilly
    // 10,000,000 and Coca-Cola 31,000,000 — but Eli Lilly holds the smallest
    // value, so ordering by value alone would name it every time and every band
    // would resolve to its bottom edge.
    const crowded: ToolResult = {
      toolCallId: 'call_3',
      columns: ['company', 'value'],
      rows: [
        ['AMD', '10603000000'],
        ['Coca-Cola', '10631000000'],
        ['Eli Lilly', '10590000000'],
      ],
    };

    const cells = match(buildEvidenceSet([crowded]), '$10.6B').filter(
      (support) => support.origin === 'cell',
    );

    expect(cells.map((support) => support.rows[0])).toEqual([0, 2, 1]);
  });

  it('does not read a value that was never recorded as zero', () => {
    const missing: ToolResult = {
      toolCallId: 'call_4',
      columns: ['company', 'revenue'],
      rows: [['Goldman', null]],
    };

    expect(supports(buildEvidenceSet([missing]), '$0')).toBe(false);
    expect(buildEvidenceSet([missing]).size).toBeGreaterThan(0); // the row count is still evidence
  });
});

describe('a value that arrived with decimals', () => {
  // `avg()` over a `bigint` column returns `numeric`, and the driver hands it
  // over as a string so the fraction survives. The model has been observed
  // copying it verbatim, so the evidence has to hold it exactly.
  const averages: ToolResult = {
    toolCallId: 'call_5',
    columns: ['sector', 'average_revenue'],
    rows: [['Consumer', '157282577777.77777778']],
  };

  it('is supported when written out in full', () => {
    expect(supports(buildEvidenceSet([averages]), '157282577777.77777778')).toBe(true);
  });

  it('is supported when written as the string the formatter would produce', () => {
    expect(supports(buildEvidenceSet([averages]), '$157.3B')).toBe(true);
  });

  it('is only rounded where the contract needs an integer', () => {
    const [support] = match(buildEvidenceSet([averages]), '157282577777.77777778');

    expect(support?.value.denominator).not.toBe(1n);
    expect(roundToInteger(support?.value ?? { numerator: 0n, denominator: 1n })).toBe(
      157_282_577_778n,
    );
  });
});

describe('values a reader expects the answer to derive', () => {
  it('supports a growth rate the results imply', () => {
    const evidence = buildEvidenceSet([nvidia]);

    expect(supports(evidence, '384.9%')).toBe(true);
    expect(match(evidence, '384.9%')[0]?.origin).toBe('growth');
  });

  it('refuses the growth rate the model actually wrote', () => {
    // Asked how fast Nvidia grew, the configured model answered "an increase of
    // 300.0%" from these two rows. The two amounts it quoted were right; this
    // was not, and no prompt rule stopped it.
    expect(supports(buildEvidenceSet([nvidia]), '300.0%')).toBe(false);
  });

  it('supports a difference, a sum and an average', () => {
    const evidence = buildEvidenceSet([nvidia]);

    expect(match(evidence, '$103.6B')[0]?.origin).toBe('difference');
    expect(match(evidence, '$157.4B')[0]?.origin).toBe('sum');
    expect(match(evidence, '$78.7B')[0]?.origin).toBe('average');
  });

  it('leaves out growth from a negative base, where the sign is not decidable', () => {
    // Intel's net income going from −18.76B to −0.27B is −98.6% if the base keeps
    // its sign and +98.6% if it does not. Both are defensible, so neither is
    // evidence: an answer that stated one and an answer that stated its negation
    // would otherwise both pass.
    const intel: ToolResult = {
      toolCallId: 'call_6',
      columns: ['year', 'net_income'],
      rows: [
        ['2024', '-18756000000'],
        ['2025', '-267000000'],
      ],
    };
    const evidence = buildEvidenceSet([intel]);

    expect(supports(evidence, '98.6%')).toBe(false);
    expect(supports(evidence, '-98.6%')).toBe(false);
    // The amounts themselves, and the change between them, remain evidence.
    expect(supports(evidence, '-$18.8B')).toBe(true);
    expect(supports(evidence, '$18.5B')).toBe(true);
  });

  it('stops narrating pairs once a result is a table rather than a sentence', () => {
    const rows = (count: number): ToolResult => ({
      toolCallId: 'call_7',
      columns: ['revenue'],
      rows: Array.from({ length: count }, (_, index) => [String((index + 1) * 1_000_000_000)]),
    });

    const narrated = buildEvidenceSet([rows(12)]);
    const tabular = buildEvidenceSet([rows(13)]);

    expect(narrated.match(bandFor('$1.0B')).some((s) => s.origin === 'difference')).toBe(true);
    expect(tabular.match(bandFor('$1.0B')).some((s) => s.origin === 'difference')).toBe(false);
    // Totals survive the cut: one per column, however many rows there are.
    expect(tabular.match(bandFor('$91.0B')).some((s) => s.origin === 'sum')).toBe(true);
  });

  it('stays bounded on the widest result the query policy allows', () => {
    const wide: ToolResult = {
      toolCallId: 'call_8',
      columns: ['a', 'b', 'c', 'd'],
      rows: Array.from({ length: 50 }, (_, row) =>
        ['a', 'b', 'c', 'd'].map((_column, index) => String(row * 4 + index + 1)),
      ),
    };

    const evidence = buildEvidenceSet([wide]);

    // Fifty rows is the ceiling the query policy writes into every statement.
    // 200 cells, one row count and two totals per column — not 40,000 pairs.
    expect(evidence.size).toBe(209);
  });
});

describe('evidence from more than one query', () => {
  it('keeps each figure attached to the call it came from', () => {
    const evidence = buildEvidenceSet([apple, nvidia]);

    expect(match(evidence, '$97.0B')[0]?.toolCallId).toBe('call_1');
    expect(match(evidence, '$130.5B')[0]?.toolCallId).toBe('call_2');
  });

  it('has nothing to say when nothing was queried', () => {
    const evidence = buildEvidenceSet([]);

    expect(evidence.size).toBe(0);
    expect(supports(evidence, '$97.0B')).toBe(false);
  });
});

describe('matching', () => {
  it('finds a value in the middle of a large set', () => {
    const many: ToolResult = {
      toolCallId: 'call_9',
      columns: ['value'],
      rows: Array.from({ length: 500 }, (_, index) => [String(index * 1_000_000)]),
    };
    const evidence = buildEvidenceSet([many]);

    const found = evidence.match(bandFor('$250.0M'));

    expect(found.length).toBeGreaterThan(0);
    expect(found.every((support) => toApproximateNumber(support.value) >= 249_950_000)).toBe(true);
  });
});

describe('a query that found nothing', () => {
  it('proves nothing at all, not even how many rows there were', () => {
    // A model that says "revenue was $0" after an empty result is inventing the
    // zero, and a row count of zero would be the only thing here to support it.
    const empty: ToolResult = { toolCallId: 'call_10', columns: ['revenue'], rows: [] };

    expect(buildEvidenceSet([empty]).size).toBe(0);
    expect(supports(buildEvidenceSet([empty]), '$0')).toBe(false);
  });
});
