import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { extractNumericClaims } from '../claims';
import type { ColumnKind, Coverage } from '../coverage';
import { buildSafeFallback } from '../fallback';
import type { ToolResult } from '../tool-result';
import { verify } from '../verify';

const coverage: Coverage = {
  years: [2022, 2023, 2024, 2025],
  columns: new Map<string, ColumnKind>([
    ['revenue', 'money'],
    ['net_income', 'money'],
    ['average_revenue', 'money'],
    ['year', 'plain'],
  ]),
};

const apple: ToolResult = {
  toolCallId: 'call_1',
  columns: ['company', 'year', 'net_income'],
  rows: [
    ['Apple', '2023', '96995000000'],
    ['Apple', '2024', '93736000000'],
  ],
};

describe('the answer of last resort', () => {
  it('shows the rows, formatted the way the tool result would have been', () => {
    const fallback = buildSafeFallback([apple], coverage);

    expect(fallback).toContain('| Apple | 2023 | $97.0B |');
    expect(fallback).toContain('| Apple | 2024 | $93.7B |');
  });

  it('passes the very verifier the drafts failed', () => {
    expect(verify(buildSafeFallback([apple], coverage), [apple], coverage).verdict).toBe('pass');
  });

  it('leaves a value that was never recorded as a gap, not as zero', () => {
    const missing: ToolResult = {
      toolCallId: 'call_2',
      columns: ['company', 'revenue'],
      rows: [['Goldman', null]],
    };

    const fallback = buildSafeFallback([missing], coverage);

    expect(fallback).toContain('| Goldman | — |');
    expect(fallback).not.toContain('$0');
  });

  it('rounds a fractional numeric into a display string that still verifies', () => {
    const averages: ToolResult = {
      toolCallId: 'call_3',
      columns: ['average_revenue'],
      rows: [['157282577777.77777778'], ['51802545454.54545455']],
    };

    const fallback = buildSafeFallback([averages], coverage);

    expect(fallback).toContain('$157.3B');
    expect(verify(fallback, [averages], coverage).verdict).toBe('pass');
  });

  it('says nothing at all rather than something unchecked, when there is nothing to show', () => {
    const empty: ToolResult = { toolCallId: 'call_4', columns: ['revenue'], rows: [] };

    for (const results of [[], [empty]]) {
      const fallback = buildSafeFallback(results, coverage);

      expect(extractNumericClaims(fallback)).toEqual([]);
      expect(verify(fallback, results, coverage).verdict).toBe('pass');
    }
  });

  it('prints a money column that is not holding money as it found it', () => {
    // An expression the model aliased into a money-looking name. There is
    // nothing to format, and inventing a number for it would be the one thing
    // this file exists not to do.
    const odd: ToolResult = {
      toolCallId: 'call_6',
      columns: ['company', 'revenue'],
      rows: [['Apple', 'undisclosed']],
    };

    const fallback = buildSafeFallback([odd], coverage);

    expect(fallback).toContain('| Apple | undisclosed |');
    expect(verify(fallback, [odd], coverage).verdict).toBe('pass');
  });

  it('gives up on the table rather than offer one that does not verify', () => {
    // A company with a digit in its name puts a figure in a text column, and the
    // verifier cannot tell it from a claim. Rather than pretend that cannot
    // happen, the table is checked and dropped when it fails.
    const awkward: ToolResult = {
      toolCallId: 'call_5',
      columns: ['company', 'net_income'],
      rows: [['3M', '96995000000']],
    };

    const fallback = buildSafeFallback([awkward], coverage);

    expect(fallback).not.toContain('3M');
    expect(verify(fallback, [awkward], coverage).verdict).toBe('pass');
  });
});

describe('the fallback always verifies', () => {
  const money = fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }).map((value) => value.toString());
  const cell = fc.oneof(money, fc.constant(null));
  const name = fc.stringMatching(/^[A-Za-z]{1,12}$/u);
  const year = fc.constantFrom('2022', '2023', '2024', '2025');

  const result = fc
    .array(fc.tuple(name, year, cell, cell), { minLength: 0, maxLength: 8 })
    .map((rows): ToolResult => ({
      toolCallId: 'call_x',
      columns: ['company', 'year', 'revenue', 'net_income'],
      rows: rows.map((row) => [...row]),
    }));

  it('holds for any rows the dataset could produce', () => {
    // The property the whole idea rests on: whatever is handed to it, the answer
    // it gives back is one the verifier accepts. The self-check makes that true
    // by construction, so what this really measures is that the construction is
    // wired up — and the test below measures that it is not simply giving up.
    fc.assert(
      fc.property(fc.array(result, { minLength: 0, maxLength: 3 }), (results) => {
        const fallback = buildSafeFallback(results, coverage);

        expect(verify(fallback, results, coverage).verdict).toBe('pass');
      }),
      { numRuns: 1_000 },
    );
  });

  it('produces a real table for ordinary rows rather than giving up', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(name, year, money, money), { minLength: 1, maxLength: 8 }),
        (rows) => {
          const results: readonly ToolResult[] = [
            {
              toolCallId: 'call_y',
              columns: ['company', 'year', 'revenue', 'net_income'],
              rows: rows.map((row) => [...row]),
            },
          ];

          expect(buildSafeFallback(results, coverage)).toContain('| company | year |');
        },
      ),
      { numRuns: 500 },
    );
  });
});
