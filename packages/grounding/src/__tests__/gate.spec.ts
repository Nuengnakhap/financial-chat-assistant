import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ColumnKind, Coverage } from '../coverage';
import { openGate, type GateEvent } from '../gate';
import type { ToolResult } from '../tool-result';
import { verify } from '../verify';

const coverage: Coverage = {
  years: [2022, 2023, 2024, 2025],
  columns: new Map<string, ColumnKind>([
    ['revenue', 'money'],
    ['net_income', 'money'],
    ['year', 'plain'],
  ]),
};

const apple: ToolResult = {
  toolCallId: 'call_1',
  columns: ['company', 'year', 'net_income'],
  rows: [['Apple', '2023', '96995000000']],
};

const comparison: ToolResult = {
  toolCallId: 'call_2',
  columns: ['company', 'year', 'revenue'],
  rows: [
    ['Apple', '2022', '394328000000'],
    ['Microsoft', '2022', '198270000000'],
    ['Apple', '2023', '383285000000'],
    ['Microsoft', '2023', '211915000000'],
  ],
};

/** An answer with prose, a table, a chart and a year range — every shape at once. */
const wholeAnswer = [
  '| Year | Apple revenue | Microsoft revenue |',
  '|---|---:|---:|',
  '| 2022 | $394.3B | $198.3B |',
  '| 2023 | $383.3B | $211.9B |',
  '',
  'Apple led in both years, reaching $383.3B in 2023 while Microsoft grew to $211.9B.',
  '',
  '```chart',
  '{"type":"line","title":"Revenue, 2022-2023","xKey":"year",' +
    '"data":[{"year":2022,"apple":394328000000},{"year":2023,"apple":383285000000}]}',
  '```',
].join('\n');

interface Run {
  readonly emitted: string;
  readonly events: readonly GateEvent[];
}

/** Feed `markdown` through a gate in the given pieces. */
function stream(markdown: string, chunks: readonly string[], results: readonly ToolResult[]): Run {
  const gate = openGate(results, coverage);
  const events: GateEvent[] = [];
  for (const chunk of chunks) events.push(...gate.push(chunk));
  events.push(...gate.flush());

  return {
    events,
    emitted: events
      .filter((event) => event.kind === 'emit')
      .map((event) => event.text)
      .join(''),
  };
}

function cut(markdown: string, sizes: readonly number[]): readonly string[] {
  const chunks: string[] = [];
  let at = 0;
  let index = 0;
  while (at < markdown.length) {
    const size = sizes[index % sizes.length] ?? 1;
    chunks.push(markdown.slice(at, at + size));
    at += size;
    index += 1;
  }

  return chunks;
}

describe('however the answer is cut up', () => {
  it('releases exactly the answer, byte for byte', () => {
    // The property the phase exists for. Nothing in the gate looks at where a
    // delta began or ended, so this holds by construction — but by construction
    // is what everyone says right up until it does not.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 40 }),
        (sizes) => {
          const run = stream(wholeAnswer, cut(wholeAnswer, sizes), [comparison]);

          expect(run.emitted).toBe(wholeAnswer);
          expect(run.events.some((event) => event.kind === 'violation')).toBe(false);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('agrees with the verifier about the same answer', () => {
    // Two readings of one answer: the gate let all of it through, and the
    // verifier passes it. Either one drifting shows up here.
    const run = stream(wholeAnswer, cut(wholeAnswer, [7]), [comparison]);

    expect(verify(wholeAnswer, [comparison], coverage).verdict).toBe('pass');
    expect(run.emitted).toBe(wholeAnswer);
  });

  it('stops at the same figure whatever the chunking', () => {
    // One display string out from 383,285,000,000, so it reads as a misread
    // digit rather than an invention — the distinction the verifier draws, made
    // here by the same code.
    const wrong = wholeAnswer.replace('$383.3B in 2023', '$383.4B in 2023');

    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 40 }),
        (sizes) => {
          const run = stream(wrong, cut(wrong, sizes), [comparison]);
          const violations = run.events.filter((event) => event.kind === 'violation');

          expect(violations).toEqual([
            { kind: 'violation', violation: { text: '$383.4B', reason: 'value_mismatch' } },
          ]);
          // Nothing after the offending figure was ever released.
          expect(wrong.startsWith(run.emitted)).toBe(true);
          expect(run.emitted).not.toContain('$383.4B');
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('what the reader is allowed to see', () => {
  it('never shows a figure before it has been checked', () => {
    const run = stream(
      'Apple earned $85.2B last year.',
      ['Apple earned $85.2B last year.'],
      [apple],
    );

    expect(run.emitted).toBe('Apple earned ');
    expect(run.events.at(-1)).toEqual({
      kind: 'violation',
      violation: { text: '$85.2B', reason: 'no_evidence' },
    });
  });

  it('says nothing more once it has stopped', () => {
    const gate = openGate([apple], coverage);
    gate.push('Apple earned $85.2B');
    gate.push(' and more besides.');

    expect(gate.push(' Even more.')).toEqual([]);
    expect(gate.flush()).toEqual([]);
  });

  it('lets ordinary prose through without waiting for anything', () => {
    const gate = openGate([apple], coverage);

    // No figure in sight, so the only thing held back is the tail that could
    // still turn into one.
    expect(gate.push('The dataset covers a handful of companies and ')).toEqual([
      { kind: 'emit', text: 'The dataset covers a handful of companies an' },
    ]);
  });

  it('holds a figure until it is whole, then releases it in one piece', () => {
    const gate = openGate([apple], coverage);
    const seen: GateEvent[] = [];

    for (const chunk of ['It was $', '97', '.0', 'B', ' exactly.\n'])
      seen.push(...gate.push(chunk));
    seen.push(...gate.flush());

    const emitted = seen
      .filter((event) => event.kind === 'emit')
      .map((event) => event.text)
      .join('');
    expect(emitted).toBe('It was $97.0B exactly.\n');
    // The figure was never split across two releases.
    const pieces = seen.filter((event) => event.kind === 'emit').map((event) => event.text);
    expect(pieces.some((piece) => piece.includes('$97') && !piece.includes('$97.0B'))).toBe(false);
  });
});

describe('the shapes that need more than a line', () => {
  it('waits for a table to end before judging its leading column', () => {
    // Whether `1` is a rank or a claim about the data depends on how many rows
    // the table turns out to have, which the second row has not said yet.
    const gate = openGate([apple], coverage);
    const table = ['| Rank | Company |', '|---|---|', '| 1 | Apple |', '| 2 | Microsoft |', ''];

    const early = table.slice(0, 3).flatMap((line) => gate.push(`${line}\n`));
    expect(early).toEqual([]);

    const rest = table.slice(3).flatMap((line) => gate.push(`${line}\n`));
    const emitted = rest
      .filter((event) => event.kind === 'emit')
      .map((event) => event.text)
      .join('');
    expect(emitted).toContain('| 1 | Apple |');
    expect(rest.some((event) => event.kind === 'violation')).toBe(false);
  });

  it('holds a chart fence until it closes', () => {
    const gate = openGate([apple], coverage);

    expect(gate.push('```chart\n{"data":[{"net_income":96995000000}]}\n')).toEqual([]);
    const closed = gate.push('```\n');
    expect(closed.some((event) => event.kind === 'emit')).toBe(true);
  });

  it('judges a chart figure by the same rule as one in prose', () => {
    const gate = openGate([apple], coverage);
    gate.push('```chart\n{"data":[{"net_income":85200000000}]}\n');

    expect(gate.push('```\n').at(-1)).toEqual({
      kind: 'violation',
      violation: { text: '85200000000', reason: 'no_evidence' },
    });
  });

  it('re-reads from the start of a line, never from where it stopped mid-line', () => {
    // Contrived on purpose — the invariant matters more than the likelihood.
    //
    // The gate releases "Totals" and stops just before the pipe, because those
    // two characters could still turn into a figure. Everything else then
    // arrives at once. Read from where it stopped, the tail " | 1 | x" is a
    // table header, the delimiter under it confirms it, and `1` sits in a
    // leading cell where a rank goes and nobody checks it. Read from the start
    // of the line, as the verifier reads it, the line begins with "Totals",
    // there is no table at all, and `1` is a figure with nothing behind it.
    const twoRows: ToolResult = {
      toolCallId: 'call_3',
      columns: ['revenue'],
      rows: [['26914000000'], ['130497000000']],
    };
    const awkward = ['Totals | 1 | x', '|---|---|', '| y | z |', 'done'].join('\n');

    const run = stream(awkward, ['Totals |', awkward.slice('Totals |'.length)], [twoRows]);

    // The reason is incidental here — two rows came back, so `1` is one string
    // from a real value. What is being pinned is that `1` is judged at all.
    expect(verify(awkward, [twoRows], coverage).violations).toEqual([
      { text: '1', reason: 'value_mismatch' },
    ]);
    expect(run.events).toContainEqual({
      kind: 'violation',
      violation: { text: '1', reason: 'value_mismatch' },
    });
  });

  it('releases a table left unclosed at the end of the answer', () => {
    const gate = openGate([apple], coverage);
    const table = '| Rank | Company |\n|---|---|\n| 1 | Apple |';
    gate.push(table);

    const emitted = gate
      .flush()
      .filter((event) => event.kind === 'emit')
      .map((event) => event.text)
      .join('');
    expect(emitted).toBe(table);
  });
});

describe('input that is not trying to be reasonable', () => {
  it('does not stall on a number that never ends', () => {
    // Held for as long as it might still be growing would be forever. Nothing
    // this system formats is anywhere near this long, so past the bound it is
    // decided with what has arrived.
    const gate = openGate([apple], coverage);
    const digits = '9'.repeat(200);

    const events = gate.push(`It was ${digits}`);

    expect(events.some((event) => event.kind === 'violation')).toBe(true);
  });

  it('releases nothing at all for an empty answer', () => {
    const gate = openGate([apple], coverage);

    expect(gate.push('')).toEqual([]);
    expect(gate.flush()).toEqual([]);
  });

  it('handles an answer delivered in one piece', () => {
    const run = stream(wholeAnswer, [wholeAnswer], [comparison]);

    expect(run.emitted).toBe(wholeAnswer);
  });

  it('handles an answer delivered one character at a time', () => {
    const run = stream(wholeAnswer, cut(wholeAnswer, [1]), [comparison]);

    expect(run.emitted).toBe(wholeAnswer);
  });
});

describe('a refusal nobody looked into', () => {
  // The gate watches this as well as the figures. Saying the dataset cannot
  // answer is a claim about the dataset, and one made without asking would
  // otherwise be on the screen well before the verifier saw it.
  const refusal = 'Sorry — that data is not available in this dataset.';

  it('never lets the phrase reach a reader when nothing was queried', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 40 }),
        (sizes) => {
          const run = stream(refusal, cut(refusal, sizes), []);

          // Exactly the text before the phrase, and not one character of the
          // phrase itself — not even the half of it that would have read as a
          // refusal to anybody watching it appear.
          expect(run.emitted).toBe(refusal.slice(0, refusal.indexOf('not available')));
          expect(run.events.at(-1)).toEqual({
            kind: 'violation',
            violation: { text: 'not available', reason: 'no_evidence' },
          });
        },
      ),
      { numRuns: 500 },
    );
  });

  it('says nothing about it once a query has run, however empty', () => {
    const empty: ToolResult = { toolCallId: 'call_4', columns: ['revenue'], rows: [] };
    const run = stream(refusal, cut(refusal, [3]), [empty]);

    expect(run.emitted).toBe(refusal);
  });

  it('still streams an answer that makes no claim at all', () => {
    // Holding everything whenever nothing was queried would be the easy fix and
    // the wrong one: a clarifying question claims nothing and should flow.
    const question = 'Which company did you have in mind?';
    const run = stream(question, cut(question, [4]), []);

    expect(run.emitted).toBe(question);
  });

  it('agrees with the verifier about all three', () => {
    const empty: ToolResult = { toolCallId: 'call_4', columns: ['revenue'], rows: [] };

    expect(verify(refusal, [], coverage).verdict).toBe('fail');
    expect(verify(refusal, [empty], coverage).verdict).toBe('pass');
    expect(verify('Which company did you have in mind?', [], coverage).verdict).toBe('pass');
  });
});
